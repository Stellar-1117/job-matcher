/**
 * Resume text extraction: PDF (pdfjs-dist), DOCX (mammoth) and plain text.
 */

export type ResumeFileKind = 'pdf' | 'docx' | 'txt';

export const MAX_RESUME_BYTES = 15 * 1024 * 1024;

export class ExtractError extends Error {
  override name = 'ExtractError';
}

/** Detect the file type from its magic bytes first, then the extension. */
export function detectKind(fileName: string, data: Uint8Array): ResumeFileKind | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const head = String.fromCharCode(...data.slice(0, 5));
  if (head.startsWith('%PDF')) return 'pdf';
  if (data[0] === 0x50 && data[1] === 0x4b && ext === 'docx') return 'docx'; // "PK" zip
  if (ext === 'txt' || ext === 'md' || ext === 'text') return 'txt';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  return null;
}

/** Tidy extracted text: unify newlines, drop control chars, trim line ends, collapse blank runs. */
export function normalizeText(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/[ \t]{2,}/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdf(data: Uint8Array): Promise<string> {
  // pdfjs-dist is ESM-only; the legacy build is the one meant for Node/Electron main.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: data.slice(), // pdfjs may detach the buffer it is given
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let out = '';
      let lastY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform?.[5] ?? null;
        // New visual line when the baseline moves noticeably and the previous item didn't end one.
        if (lastY != null && y != null && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
        out += item.str;
        if (item.hasEOL) out += '\n';
        if (y != null) lastY = y;
      }
      pages.push(out);
      page.cleanup();
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}

async function extractDocx(data: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth');
  const res = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  return res.value;
}

export async function extractResumeText(fileName: string, data: Uint8Array): Promise<{ kind: ResumeFileKind; text: string }> {
  if (data.byteLength === 0) throw new ExtractError('The file is empty.');
  if (data.byteLength > MAX_RESUME_BYTES) throw new ExtractError('The file is larger than 15 MB.');
  const kind = detectKind(fileName, data);
  if (!kind) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    throw new ExtractError(ext === 'doc' ? 'Old .doc files are not supported — save it as .docx or PDF.' : 'Unsupported file type. Use PDF, DOCX or TXT.');
  }
  let raw: string;
  try {
    raw = kind === 'pdf' ? await extractPdf(data) : kind === 'docx' ? await extractDocx(data) : new TextDecoder('utf-8').decode(data);
  } catch (e) {
    throw new ExtractError(`Could not read the ${kind.toUpperCase()} file: ${(e as Error).message}`);
  }
  const text = normalizeText(raw);
  if (text.replace(/\s/g, '').length < 30) {
    throw new ExtractError(
      kind === 'pdf'
        ? 'No text found in this PDF (it may be a scanned image). Upload a DOCX/TXT version or paste the text instead.'
        : 'No text found in this file.',
    );
  }
  return { kind, text };
}
