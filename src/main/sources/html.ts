import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'ul', 'ol', 'table', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre',
]);

/** Decode HTML entities ("&lt;p&gt;" → "<p>"); Greenhouse returns its job content entity-escaped. */
export function decodeEntities(s: string): string {
  return cheerio.load(`<textarea>${s.replace(/<\/textarea/gi, '&lt;/textarea')}</textarea>`)('textarea').text();
}

/** Convert job-description HTML to readable plain text (paragraphs, bullet lists, headings). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, svg').remove();
  const out: string[] = [];
  const walk = (nodes: AnyNode[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        out.push((node as unknown as { data: string }).data.replace(/\s+/g, ' '));
      } else if (node.type === 'tag') {
        const el = node as Element;
        const tag = el.tagName.toLowerCase();
        if (tag === 'br') {
          out.push('\n');
          continue;
        }
        if (tag === 'li') out.push('\n- ');
        else if (BLOCK_TAGS.has(tag)) out.push('\n\n');
        walk(el.children);
        if (BLOCK_TAGS.has(tag)) out.push('\n\n');
        else if (tag === 'td' || tag === 'th') out.push(' ');
      }
    }
  };
  walk($.root().children().toArray());
  return out
    .join('')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n- \n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface JsonLdJobPosting {
  title: string | null;
  url: string | null;
  identifier: string | null;
  datePosted: string | null;
  validThrough: string | null;
  companyName: string | null;
  location: string | null;
  descriptionText: string | null;
  employmentType: string | null;
  raw: Record<string, unknown>;
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

function addressText(loc: any): string | null {
  const a = loc?.address ?? loc;
  if (!a || typeof a !== 'object') return str(loc);
  const parts = [a.addressLocality, a.addressRegion, typeof a.addressCountry === 'object' ? a.addressCountry?.name : a.addressCountry]
    .map(str)
    .filter(Boolean);
  return parts.length ? [...new Set(parts)].join(', ') : null;
}

function isJobPosting(node: any): boolean {
  return asArray(node?.['@type']).some((t) => String(t).toLowerCase() === 'jobposting');
}

/** Find every schema.org JobPosting in a page's JSON-LD (handles @graph, ItemList and arrays). */
export function extractJsonLdJobPostings(html: string, pageUrl: string): JsonLdJobPosting[] {
  const $ = cheerio.load(html);
  const found: any[] = [];
  const visit = (node: any, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    if (isJobPosting(node)) found.push(node);
    for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity']) if (node[key]) visit(node[key], depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    try {
      visit(JSON.parse(text));
    } catch {
      // Some sites emit invalid JSON-LD; try stripping control characters once.
      try {
        visit(JSON.parse(text.replace(/[\u0000-\u001F]+/g, ' ')));
      } catch {
        /* ignore */
      }
    }
  });
  return found.map((j) => {
    const org = asArray(j.hiringOrganization)[0];
    const locs = asArray(j.jobLocation).map(addressText).filter(Boolean) as string[];
    const remote = String(j.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE';
    let url = str(j.url);
    try {
      url = url ? new URL(url, pageUrl).toString() : null;
    } catch {
      url = null;
    }
    const identifier = typeof j.identifier === 'object' ? str(j.identifier?.value) : str(j.identifier);
    return {
      title: str(j.title),
      url,
      identifier,
      datePosted: str(j.datePosted),
      validThrough: str(j.validThrough),
      companyName: typeof org === 'object' ? str(org?.name) : str(org),
      location: [...new Set(locs)].join(' / ') || (remote ? 'Remote' : null),
      descriptionText: j.description ? htmlToText(decodeEntities(String(j.description))) : null,
      employmentType: asArray(j.employmentType).map(String).join(', ') || null,
      raw: j,
    };
  });
}

/** Main readable text of an arbitrary page via Mozilla Readability (lazy-loads jsdom). */
export async function readabilityText(html: string, url: string): Promise<{ title: string | null; text: string }> {
  const [{ JSDOM, VirtualConsole }, { Readability }] = await Promise.all([import('jsdom'), import('@mozilla/readability')]);
  const vc = new VirtualConsole(); // swallow CSS/script parse noise
  const dom = new JSDOM(html, { url, virtualConsole: vc });
  try {
    const article = new Readability(dom.window.document).parse();
    const text = article?.content ? htmlToText(article.content) : (article?.textContent ?? '').trim();
    return { title: article?.title?.trim() || dom.window.document.title?.trim() || null, text };
  } finally {
    dom.window.close();
  }
}

/** The page's own name for the organisation: og:site_name, else the <title> before a separator. */
export function siteName(html: string): string | null {
  const $ = cheerio.load(html);
  const og = $('meta[property="og:site_name"]').attr('content')?.trim();
  if (og) return og;
  const title = $('title').first().text().trim();
  if (!title) return null;
  const generic = /^(careers?|jobs?|open (positions|roles)|join us|work with us|home|we'?re hiring|current openings)$/i;
  const parts = title.split(/\s[|\-–—:]\s/).map((s) => s.trim()).filter((s) => s && !generic.test(s));
  return parts.sort((a, b) => a.length - b.length)[0] ?? null;
}
