import { createServer, type Server } from 'node:http';
import { resumeFileName } from '@shared/results';
import { getPdfByToken } from '../repos/tailored';
import { getSettings } from '../repos/settings';
import { resumeServerAddress } from './resumeLink';

/**
 * Hands tailored PDFs to other laptops on the same network. There's no login, by the user's choice, so
 * the only thing it can ever do is answer GET /r/<random token> with that one PDF. Everything else is a 404.
 */

const LINK_PATH = /^\/r\/([\w-]{16,64})$/;

export type PdfLookup = (token: string) => { pdf: Buffer; profileName: string } | null;

/** RFC 6266 / 5987: a plain ASCII name for old clients, and the exact name in UTF-8 for the rest. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function createResumeServer(lookup: PdfLookup): Server {
  return createServer((req, res) => {
    const notFound = () => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    };
    const token = req.method === 'GET' ? LINK_PATH.exec((req.url ?? '').split('?')[0])?.[1] : null;
    if (!token) return notFound();
    try {
      const file = lookup(token);
      if (!file) return notFound();
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': file.pdf.length,
        'Content-Disposition': contentDisposition(resumeFileName(file.profileName)),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(file.pdf);
    } catch (e) {
      console.error(`[resume server] ${(e as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  });
}

let server: Server | null = null;
let lastError: string | null = null;

/** Resolves once it's listening or has failed to; a port in use is recorded for Settings, not thrown. */
export function startResumeServer(): Promise<void> {
  if (server) return Promise.resolve();
  const { port } = getSettings().lan;
  const s = createResumeServer(getPdfByToken);
  server = s;
  lastError = null;
  return new Promise((resolve) => {
    s.on('error', (e: NodeJS.ErrnoException) => {
      // Links just don't work until it's changed in Settings; the rest of the app is unaffected.
      lastError = e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose another port.` : e.message;
      console.warn(`[resume server] ${lastError}`);
      if (server === s) server = null;
      resolve();
    });
    s.listen(port, '0.0.0.0', () => resolve());
  });
}

export function stopResumeServer(): Promise<void> {
  const s = server;
  server = null;
  if (!s?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections();
  });
}

export async function restartResumeServer(): Promise<void> {
  await stopResumeServer();
  await startResumeServer();
}

export function resumeServerStatus(): { listening: boolean; address: string; error: string | null } {
  return { listening: !!server?.listening, address: resumeServerAddress(), error: lastError };
}
