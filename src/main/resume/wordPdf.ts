import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * DOCX → PDF through Microsoft Word, driven over COM from PowerShell, so the PDF keeps exactly the
 * layout Word gives the document. Windows only, with no fallback: without Word the export fails.
 *
 * The script goes in over stdin and the paths through environment variables, because PowerShell
 * reads stdin in the console's code page and would garble a non-ASCII temp path. It's one line
 * because `-Command -` treats stdin like interactive input, line by line.
 */

const TIMEOUT_MS = 120_000;

const WORD_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8;',
  '$word = $null;',
  '$doc = $null;',
  '$new = @();',
  'try {',
  '$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id });',
  '$word = New-Object -ComObject Word.Application;',
  '$new = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id } | Where-Object { $before -notcontains $_ });',
  // Killing PowerShell on timeout doesn't stop Word (COM starts it), so the parent needs its pid. Only
  // a single new process is certainly ours: never report one that could be the user's own Word.
  'if ($new.Count -eq 1) { [Console]::Out.WriteLine("WORDPID=$($new[0])") };',
  '$word.Visible = $false;',
  '$word.DisplayAlerts = 0;',
  '$doc = $word.Documents.Open($env:JM_DOCX, $false, $true, $false);',
  '$pages = $doc.ComputeStatistics(2);', // wdStatisticPages
  '$doc.SaveAs2($env:JM_PDF, 17);', // wdFormatPDF
  '[Console]::Out.WriteLine("PAGES=$pages");',
  '} catch {',
  '[Console]::Out.WriteLine("ERROR=$($_.Exception.Message)");',
  '} finally {',
  'if ($doc) { try { $doc.Close(0) } catch {} };', // wdDoNotSaveChanges
  // Quit takes its argument by reference; a plain 0 throws and leaves Word running hidden.
  'if ($word) { try { $word.Quit([ref]0) } catch { if ($new.Count -eq 1) { Stop-Process -Id $new[0] -Force } } };',
  '}',
].join(' ');

export class WordPdfError extends Error {
  override name = 'WordPdfError';
}

export interface WordPdfResult {
  pdf: Buffer;
  /** Page count as Word lays the document out. */
  pages: number;
}

function friendlyError(message: string): WordPdfError {
  if (/80040154|REGDB_E_CLASSNOTREG/i.test(message)) {
    return new WordPdfError('Microsoft Word isn\'t installed on this PC, and it\'s needed to make the PDF.');
  }
  if (/language mode/i.test(message)) {
    return new WordPdfError(`Windows blocked the app from starting Microsoft Word: ${message}`);
  }
  return new WordPdfError(`Microsoft Word couldn't make the PDF: ${message}`);
}

/** Run the script once. Resolves with Word's page count once the PDF has been written. */
function runWord(docxPath: string, pdfPath: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { windowsHide: true, env: { ...process.env, JM_DOCX: docxPath, JM_PDF: pdfPath } },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      const wordPid = /^WORDPID=(\d+)/m.exec(stdout)?.[1];
      if (wordPid) {
        try {
          process.kill(Number(wordPid));
        } catch {
          // Word already exited.
        }
      }
    }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new WordPdfError(`Couldn't start PowerShell to run Microsoft Word: ${e.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) return reject(new WordPdfError(`Microsoft Word didn't finish within ${Math.round(timeoutMs / 1000)}s.`));
      const error = /^ERROR=(.*)$/m.exec(stdout)?.[1];
      if (error) return reject(friendlyError(error.trim()));
      const pages = /^PAGES=(\d+)/m.exec(stdout)?.[1];
      if (!pages) return reject(friendlyError(stderr.trim() || stdout.trim() || 'PowerShell returned nothing.'));
      resolve(Number(pages));
    });
    child.stdin.on('error', () => {}); // a failed spawn is reported by the 'error' event above
    child.stdin.end(`${WORD_SCRIPT}\n`);
  });
}

async function exportOnce(docx: Uint8Array, timeoutMs: number): Promise<WordPdfResult> {
  const dir = await mkdtemp(join(tmpdir(), 'jobmatcher-word-'));
  try {
    const docxPath = join(dir, 'resume.docx');
    const pdfPath = join(dir, 'resume.pdf');
    await writeFile(docxPath, docx);
    const pages = await runWord(docxPath, pdfPath, timeoutMs);
    return { pdf: await readFile(pdfPath), pages };
  } finally {
    // Word can hold its files for a moment after quitting. A leftover temp folder isn't worth failing over.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Export a DOCX to PDF. Calls run one at a time, since each one starts its own hidden Word. */
export function docxToPdf(docx: Uint8Array, timeoutMs = TIMEOUT_MS): Promise<WordPdfResult> {
  const job = queue.then(() => exportOnce(docx, timeoutMs));
  queue = job.catch(() => {});
  return job;
}
