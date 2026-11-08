import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import JSZip from 'jszip';
import type { ResumeParsed } from '@shared/llm-schemas';

/**
 * Read and rewrite resume paragraphs in a DOCX without touching its layout. The XML is only parsed to
 * find positions: an edited paragraph is spliced into the original string, so every other byte of
 * word/document.xml (and every other file in the zip) stays as it was.
 *
 * What may change is a whitelist: only rewritable paragraphs in the experience and skills sections.
 * Text is exchanged with `**bold**` markers, since resumes often bold words mid-sentence.
 */

const DOCUMENT_XML = 'word/document.xml';
/** Non-list text in the experience section shorter than this is a role line or sub-heading, not a description. */
const MIN_LONG_TEXT = 100;
/** Longer than this is refused. The model is told a tighter limit, since it can only roughly count characters. */
const MAX_GROWTH = 1.25;
const PROMPT_GROWTH = 1.15;

const EXPERIENCE_HEADING = /^(?:(?:work|professional|relevant|employment)\s+)?(?:experience|history)$/;
const SKILLS_HEADING = /^(?:(?:technical|core|key|relevant)\s+)?(?:skills|competencies)$|^tech(?:nical)?\s+(?:stack|skills)$/;
const OTHER_HEADING = /^(?:summary|profile|objective|education|highlights|projects|certifications?|awards|publications|languages|interests)$/;
const HEADING_STYLE = /^(?:heading[12]|title)$/i;
const LIST_STYLE = /list/i;
/** A number, but not one inside a name like S3, EC2 or p99. */
const NUMBER = /(?<![\p{L}\d.,])\d+(?:[.,]\d+)*/gu;
const DATE_RANGE = /\b(?:19|20)\d{2}\b\s*(?:[-–—]|to)\s*(?:present|current|now|(?:[a-z]+\.?\s+)?(?:19|20)\d{2}\b)/i;

/** Run properties with no visual effect on the text (bold is what the markers carry). */
const IGNORED_RUN_PROPS = new Set(['w:b', 'w:bCs', 'w:lang', 'w:noProof']);
const SAFE_PARAGRAPH_CHILDREN = new Set(['w:pPr', 'w:r', 'w:proofErr']);
const SAFE_RUN_CHILDREN = new Set(['w:rPr', 'w:t', 'w:lastRenderedPageBreak']);

export class DocxError extends Error {
  override name = 'DocxError';
}

export type DocxSection = 'experience' | 'skills' | 'other';

export interface DocxParagraph {
  id: number;
  /** The paragraph's text with `**bold**` markers. */
  text: string;
  section: DocxSection;
  isList: boolean;
  isHeading: boolean;
  /** False when the paragraph holds anything a plain rebuild would lose: tabs, links, mixed fonts, sizes or colors. */
  rewritable: boolean;
}

export interface ClassifiedParagraph extends DocxParagraph {
  editable: boolean;
}

export interface DocxEdit {
  id: number;
  text: string;
}

export interface DocxChange {
  id: number;
  before: string;
  after: string;
}

export interface ApplyResult {
  docx: Uint8Array;
  changes: DocxChange[];
  /** How many edits were refused: unknown or locked paragraph, unbalanced markers, empty, too long, or a new number. */
  dropped: number;
  /** Why, for the log. No resume text. */
  refusals: string[];
}

interface RunInfo {
  bold: boolean;
  text: string;
  rPr: Element | null;
}

interface ParsedParagraph extends DocxParagraph {
  el: Element;
  pPr: Element | null;
  runs: RunInfo[];
}

const tags = (n: { children: AnyNode[] }): Element[] => n.children.filter((c): c is Element => c.type === 'tag');
const childTag = (n: Element, name: string) => tags(n).find((c) => c.name === name) ?? null;
const rawXml = (xml: string, n: AnyNode) => xml.slice(n.startIndex!, n.endIndex! + 1);
const plainText = (marked: string) => marked.replace(/\*\*/g, '');
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function isBold(rPr: Element | null): boolean {
  const b = rPr && childTag(rPr, 'w:b');
  return !!b && !['0', 'false', 'off'].includes(b.attribs['w:val'] ?? '');
}

/** What a run looks like, apart from bold: two runs with the same key differ in nothing a reader could see. */
function formatKey(rPr: Element | null): string {
  if (!rPr) return '';
  return tags(rPr)
    .filter((c) => !IGNORED_RUN_PROPS.has(c.name))
    .map((c) => `${c.name}${JSON.stringify(Object.entries(c.attribs).sort())}`)
    .sort()
    .join('|');
}

function runText(run: Element): string {
  let out = '';
  for (const t of tags(run)) {
    if (t.name !== 'w:t') continue;
    for (const c of t.children) if (c.type === 'text') out += c.data;
  }
  return out;
}

/** Runs as `**bold**` text. Adjacent same-weight runs merge, and spaces at the edge of bold stay outside the markers. */
function markedText(runs: RunInfo[]): string {
  const merged: { bold: boolean; text: string }[] = [];
  for (const r of runs) {
    const bold = r.bold && !!r.text.trim();
    const last = merged.at(-1);
    if (last && last.bold === bold) last.text += r.text;
    else merged.push({ bold, text: r.text });
  }
  return merged
    .map((m) => {
      if (!m.bold) return m.text;
      const [, lead, core, trail] = /^(\s*)(.*?)(\s*)$/s.exec(m.text)!;
      return `${lead}**${core}**${trail}`;
    })
    .join('');
}

function headingSection(text: string, style: string | null, isList: boolean): DocxSection | null {
  const name = plainText(text).trim().replace(/[:：]$/, '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!name || isList) return null;
  if (EXPERIENCE_HEADING.test(name)) return 'experience';
  if (SKILLS_HEADING.test(name)) return 'skills';
  if (OTHER_HEADING.test(name)) return 'other';
  // Any other top-level heading ends the current section, so what follows it stays locked.
  if (style && HEADING_STYLE.test(style)) return 'other';
  const raw = plainText(text).trim();
  if (raw.length <= 40 && !/\d/.test(raw) && /\p{L}/u.test(raw) && raw === raw.toUpperCase()) return 'other';
  return null;
}

function parseDocument(xml: string): ParsedParagraph[] {
  const $ = cheerio.load(xml, { xml: { xmlMode: true, withStartIndices: true, withEndIndices: true } });
  const documentEl = tags($.root()[0]).find((c) => c.name === 'w:document');
  const body = documentEl && childTag(documentEl, 'w:body');
  if (!body) throw new DocxError("This Word file has no document body, so it can't be tailored.");

  // Only body-level paragraphs are ever read: anything inside a table or text box stays out of reach.
  let section: DocxSection = 'other';
  const out: ParsedParagraph[] = [];
  tags(body)
    .filter((c) => c.name === 'w:p')
    .forEach((el, id) => {
      const pPr = childTag(el, 'w:pPr');
      const style = (pPr && childTag(pPr, 'w:pStyle')?.attribs['w:val']) || null;
      const isList = !!pPr && (!!childTag(pPr, 'w:numPr') || (!!style && LIST_STYLE.test(style)));
      const runEls = tags(el).filter((c) => c.name === 'w:r');
      const runs = runEls.map((r): RunInfo => {
        const rPr = childTag(r, 'w:rPr');
        return { bold: isBold(rPr), text: runText(r), rPr };
      });
      const textRuns = runs.filter((r) => r.text);
      const text = markedText(textRuns);
      const rewritable =
        textRuns.length > 0 &&
        tags(el).every((c) => SAFE_PARAGRAPH_CHILDREN.has(c.name)) &&
        runEls.every((r) => tags(r).every((c) => SAFE_RUN_CHILDREN.has(c.name))) &&
        new Set(textRuns.map((r) => formatKey(r.rPr))).size === 1 &&
        !textRuns.some((r) => r.text.includes('**'));
      const heading = headingSection(text, style, isList);
      if (heading) section = heading;
      out.push({ id, text, section, isList, isHeading: !!heading, rewritable, el, pPr, runs: textRuns });
    });
  return out;
}

async function loadDocument(docx: Uint8Array): Promise<{ zip: JSZip; file: JSZip.JSZipObject; xml: string }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(docx);
  } catch {
    throw new DocxError("This file isn't a readable Word document.");
  }
  const file = zip.file(DOCUMENT_XML);
  if (!file) throw new DocxError("This file isn't a readable Word document.");
  return { zip, file, xml: await file.async('string') };
}

export async function readParagraphs(docx: Uint8Array): Promise<DocxParagraph[]> {
  const { xml } = await loadDocument(docx);
  return parseDocument(xml).map(({ id, text, section, isList, isHeading, rewritable }) => ({ id, text, section, isList, isHeading, rewritable }));
}

export function containsPhrase(text: string, phrase: string): boolean {
  const p = phrase.trim();
  if (p.length < 2) return false;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Decide what the model may rewrite. Whatever isn't recognized stays locked. */
export function classifyParagraphs(paragraphs: DocxParagraph[], structured: Pick<ResumeParsed, 'roles'>): ClassifiedParagraph[] {
  const names = structured.roles.flatMap((r) => [r.company, r.title]).filter((n): n is string => !!n);
  const editable = (p: DocxParagraph): boolean => {
    if (!p.rewritable || p.isHeading) return false;
    if (p.section === 'skills') return true;
    if (p.section !== 'experience') return false;
    const text = plainText(p.text);
    if (!p.isList && text.length < MIN_LONG_TEXT) return false;
    return !DATE_RANGE.test(text) && !names.some((n) => containsPhrase(text, n));
  };
  const out = paragraphs.map((p) => ({ ...p, editable: editable(p) }));
  if (!out.some((p) => p.editable)) {
    throw new DocxError('Nothing in this resume can be tailored: no bullets or skills were found under Experience or Skills headings.');
  }
  return out;
}

/** {{resume_paragraphs}}: the whole resume in order, editable paragraphs with their id, the rest as context. */
export function renderParagraphs(paragraphs: ClassifiedParagraph[]): string {
  return paragraphs
    .filter((p) => p.text.trim())
    .map((p) => `${p.editable ? `[${p.id}, max ${Math.floor(plainText(p.text).length * PROMPT_GROWTH)} chars]` : '[locked]'} ${p.text}`)
    .join('\n');
}

/** Split `**bold**` text into segments; null when the markers don't pair up. */
function parseMarkers(text: string): { bold: boolean; text: string }[] | null {
  const parts = text.split('**');
  if (parts.length % 2 === 0) return null;
  return parts.map((t, i) => ({ bold: i % 2 === 1, text: t })).filter((s) => s.text);
}

function boldProps(xml: string, plain: Element | null): string {
  if (!plain) return '<w:rPr><w:b/><w:bCs/></w:rPr>';
  // Schema order: rStyle and rFonts come before b.
  const kids = tags(plain);
  const before = kids.filter((c) => c.name === 'w:rStyle' || c.name === 'w:rFonts').map((c) => rawXml(xml, c));
  const after = kids.filter((c) => c.name !== 'w:rStyle' && c.name !== 'w:rFonts').map((c) => rawXml(xml, c));
  return `<w:rPr>${before.join('')}<w:b/><w:bCs/>${after.join('')}</w:rPr>`;
}

function plainProps(xml: string, bold: Element): string {
  const kids = tags(bold).filter((c) => c.name !== 'w:b' && c.name !== 'w:bCs');
  return kids.length ? `<w:rPr>${kids.map((c) => rawXml(xml, c)).join('')}</w:rPr>` : '';
}

/** The paragraph rebuilt from segments: same opening tag and pPr, runs using the paragraph's own plain and bold properties. */
function rebuildParagraph(xml: string, p: ParsedParagraph, segments: { bold: boolean; text: string }[]): string {
  const plainRun = p.runs.find((r) => !r.bold);
  const boldRun = p.runs.find((r) => r.bold);
  const plain = plainRun ? (plainRun.rPr ? rawXml(xml, plainRun.rPr) : '') : plainProps(xml, boldRun!.rPr!);
  const bold = boldRun ? rawXml(xml, boldRun.rPr!) : boldProps(xml, plainRun!.rPr);
  const firstChild = p.el.children[0];
  const open = xml.slice(p.el.startIndex!, firstChild.startIndex!);
  const runs = segments.map((s) => `<w:r>${s.bold ? bold : plain}<w:t xml:space="preserve">${escapeXml(s.text)}</w:t></w:r>`).join('');
  return `${open}${p.pPr ? rawXml(xml, p.pPr) : ''}${runs}</w:p>`;
}

/** Characters XML 1.0 can't hold, and line breaks a single-paragraph edit shouldn't have. */
function cleanEditText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/\s*[\r\n\t]+\s*/g, ' ')
      .trim()
  );
}

/**
 * Apply edits to the paragraphs in `editableIds`. Refused edits leave the original paragraph in place
 * and are counted. Only word/document.xml changes.
 */
export async function applyEdits(docx: Uint8Array, edits: DocxEdit[], editableIds: ReadonlySet<number>): Promise<ApplyResult> {
  const { zip, file, xml } = await loadDocument(docx);
  const byId = new Map(parseDocument(xml).map((p) => [p.id, p]));
  const seen = new Set<number>();
  const changes: DocxChange[] = [];
  const replacements: { start: number; end: number; xml: string }[] = [];
  const refusals: string[] = [];

  for (const edit of edits) {
    const p = byId.get(edit.id);
    if (!p || !p.rewritable || !editableIds.has(edit.id)) {
      refusals.push(`${edit.id}: locked or unknown`);
      continue;
    }
    if (seen.has(edit.id)) {
      refusals.push(`${edit.id}: duplicate`);
      continue;
    }
    seen.add(edit.id);
    const text = cleanEditText(edit.text);
    const segments = parseMarkers(text);
    const newLength = plainText(text).length;
    const oldLength = plainText(p.text).length;
    if (!segments) {
      refusals.push(`${edit.id}: unbalanced bold markers`);
      continue;
    }
    if (!plainText(text).trim()) {
      refusals.push(`${edit.id}: empty`);
      continue;
    }
    if (newLength > oldLength * MAX_GROWTH) {
      refusals.push(`${edit.id}: too long (${newLength} chars, was ${oldLength})`);
      continue;
    }
    // A metric the paragraph didn't have can only be invented.
    const known = new Set(p.text.match(NUMBER));
    const invented = text.match(NUMBER)?.find((n) => !known.has(n));
    if (invented) {
      refusals.push(`${edit.id}: new number ${invented}`);
      continue;
    }
    if (text === p.text.trim()) continue; // nothing actually changed
    changes.push({ id: p.id, before: p.text, after: text });
    replacements.push({ start: p.el.startIndex!, end: p.el.endIndex! + 1, xml: rebuildParagraph(xml, p, segments) });
  }

  const dropped = refusals.length;
  if (!replacements.length) return { docx, changes, dropped, refusals };
  let out = xml;
  for (const r of replacements.sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + r.xml + out.slice(r.end);
  zip.file(DOCUMENT_XML, out, { date: file.date, createFolders: false });
  return { docx: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), changes, dropped, refusals };
}
