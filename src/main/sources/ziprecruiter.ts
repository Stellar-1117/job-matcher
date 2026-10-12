import * as cheerio from 'cheerio';
import { htmlToText } from './html';

/**
 * ZipRecruiter job pages (/jobs/v2/…, /c/…/Job/…) have no JSON-LD and also list "similar jobs",
 * which confuses Readability. The posting itself sits in a header block (title, location,
 * employer, salary, "Posted N days ago") followed by a "Job description" section.
 */
export interface ZipRecruiterPosting {
  title: string | null;
  companyName: string | null;
  location: string | null;
  /** "Posted 5 days ago" etc., for the relative-date parser. */
  postedText: string | null;
  /** Header facts plus the job description, as plain text. */
  text: string;
}

export function isZipRecruiterUrl(url: string): boolean {
  try {
    return /(^|\.)ziprecruiter\.(com|co\.uk|ca)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parseZipRecruiterPage(html: string): ZipRecruiterPosting | null {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, template').remove();
  const heading = $('h2, h3')
    .filter((_, e) => /^job description$/i.test(clean($(e).text())))
    .first();
  if (!heading.length) return null;
  const body = heading.nextAll().first();
  const description = htmlToText(body.html() ?? '');
  if (!description) return null;

  const titleBox = $('[data-testid="serp-job-details-title"]').first();
  const title = clean(titleBox.find('h1, h2').first().text()) || null;
  const location = clean(titleBox.parent().find('p').first().text()) || null;
  const companyName = clean($('[data-testid="employer-details-header"] span').first().text()) || null;

  // Header facts: the largest block around the title that doesn't reach into the description.
  let header = titleBox.length ? titleBox : null;
  while (header && header.parent().length && !header.parent().find(heading).length) header = header.parent();
  const headerText = header ? htmlToText(header.html() ?? '').replace(/^Learn more about .*$/gim, '').replace(/\n{3,}/g, '\n\n').trim() : '';
  const postedText = headerText.match(/posted [^\n]*?ago|posted today|posted yesterday|just posted/i)?.[0] ?? null;

  return { title, companyName, location, postedText, text: headerText ? `${headerText}\n\n${description}` : description };
}
