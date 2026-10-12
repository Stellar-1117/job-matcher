import { describe, expect, it } from 'vitest';
import { detectKind, extractResumeText, normalizeText, ExtractError } from '../src/main/resume/extract';
import { makeDocx, makePdf } from './fixtures';

const LINES = ['Jordan Lee', 'Senior Backend Engineer', 'Go, PostgreSQL, Kafka, Kubernetes', 'PayFlow 2019 - present: built a ledger service'];

describe('extractResumeText', () => {
  it('extracts text from a PDF, one line per text line', async () => {
    const { kind, text } = await extractResumeText('cv.pdf', makePdf(LINES));
    expect(kind).toBe('pdf');
    expect(text.split('\n')).toEqual(LINES);
  });

  it('extracts text from a DOCX', async () => {
    const { kind, text } = await extractResumeText('cv.docx', await makeDocx(LINES));
    expect(kind).toBe('docx');
    for (const l of LINES) expect(text).toContain(l);
  });

  it('reads TXT (UTF-8 with BOM, CRLF)', async () => {
    const data = new TextEncoder().encode('﻿' + LINES.join('\r\n') + '\r\n\r\n\r\n\r\nMünchen ✓');
    const { kind, text } = await extractResumeText('cv.txt', data);
    expect(kind).toBe('txt');
    expect(text).toBe(LINES.join('\n') + '\n\nMünchen ✓');
  });

  it('rejects unsupported, empty and text-less files with clear messages', async () => {
    await expect(extractResumeText('cv.doc', new Uint8Array([1, 2, 3]))).rejects.toThrow(/\.docx or PDF/);
    await expect(extractResumeText('cv.png', new Uint8Array([1, 2, 3]))).rejects.toThrow(/Unsupported/);
    await expect(extractResumeText('cv.txt', new Uint8Array())).rejects.toThrow(/empty/);
    await expect(extractResumeText('cv.pdf', makePdf([' ']))).rejects.toThrow(/scanned/);
    await expect(extractResumeText('cv.pdf', new TextEncoder().encode('%PDF-1.4 garbage'))).rejects.toBeInstanceOf(ExtractError);
  });
});

describe('helpers', () => {
  it('detects kind by magic bytes before extension', () => {
    expect(detectKind('resume.txt', makePdf(['x']))).toBe('pdf');
    expect(detectKind('resume.TXT', new TextEncoder().encode('hello'))).toBe('txt');
  });

  it('normalizes whitespace', () => {
    expect(normalizeText('a  b\t\t\n\n\n\nc d  \r\n')).toBe('a b\n\nc d');
  });
});
