import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { contentDisposition, createResumeServer } from '../src/main/net/resumeServer';
import { firstPrivateIpv4 } from '../src/main/net/resumeLink';
import { resumeFileName } from '../src/shared/results';

const TOKEN = 'abcdefghijklmnop_-123';
const PDF = Buffer.from('%PDF-1.4 fake');

let server: Server | null = null;

async function start(profileName = 'Alex Main'): Promise<string> {
  server = createResumeServer((t) => (t === TOKEN ? { pdf: PDF, profileName } : null));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(null)));
  server = null;
});

describe('resume server', () => {
  it('serves the PDF under the profile name', async () => {
    const res = await fetch(`${await start()}/r/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Alex Main.pdf"; filename*=UTF-8''Alex%20Main.pdf`);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it('encodes a non-ASCII profile name', async () => {
    const res = await fetch(`${await start('José Núñez')}/r/${TOKEN}`);
    const header = res.headers.get('content-disposition')!;
    expect(header).toContain('filename="Jos_ N__ez.pdf"');
    expect(header).toContain(`filename*=UTF-8''Jos%C3%A9%20N%C3%BA%C3%B1ez.pdf`);
  });

  it('returns 404 for unknown tokens, other paths and other methods', async () => {
    const base = await start();
    for (const path of ['/', '/r/', `/r/${TOKEN}/x`, '/r/short', '/r/unknownunknownunknown', '/r/../../etc/passwd', `/R/${TOKEN}`, `/x/${TOKEN}`]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
    expect((await fetch(`${base}/r/${TOKEN}`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/r/${TOKEN}`, { method: 'HEAD' })).status).toBe(404);
  });
});

describe('file names and links', () => {
  it('makes profile names safe for the filesystem', () => {
    expect(resumeFileName('Alex Main')).toBe('Alex Main.pdf');
    expect(resumeFileName('A/B: "C"?')).toBe('A B C.pdf');
    expect(resumeFileName(' José. ')).toBe('José.pdf');
    expect(resumeFileName('...')).toBe('resume.pdf');
  });

  it('escapes quotes in the header', () => {
    expect(contentDisposition(`O'Brien (1).pdf`)).toBe(`attachment; filename="O'Brien (1).pdf"; filename*=UTF-8''O%27Brien%20%281%29.pdf`);
  });

  it('prefers a real adapter over a virtual one, and ignores public and internal addresses', () => {
    const iface = (address: string, internal = false) => ({ address, internal, family: 'IPv4' as const, netmask: '', mac: '', cidr: null });
    expect(firstPrivateIpv4({ 'vEthernet (WSL)': [iface('172.20.0.1')], 'Wi-Fi': [iface('192.168.1.20')] })).toBe('192.168.1.20');
    expect(firstPrivateIpv4({ 'vEthernet (WSL)': [iface('172.20.0.1')] })).toBe('172.20.0.1');
    expect(firstPrivateIpv4({ lo: [iface('10.0.0.1', true)], Ethernet: [iface('8.8.8.8')] })).toBeNull();
  });
});
