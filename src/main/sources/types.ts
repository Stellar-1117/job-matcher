import type { HttpClient } from '../net/http';

export type AtsKey = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'icims';
export type AdapterKey = AtsKey | 'generic';

export type PostedAtSource = 'source' | 'source_republish' | 'relative' | 'first_seen';

/** One posting as returned by a source adapter, before it is stored. */
export interface RawJob {
  /** The posting's public URL (becomes the canonical URL after normalization). */
  url: string;
  /** Other URLs for the same posting (e.g. the ATS board URL when `url` is the company site). */
  altUrls?: string[];
  externalId: string | null;
  title: string;
  companyName: string | null;
  location: string | null;
  postedAt: string | null;
  postedAtSource: PostedAtSource;
  /** Known upper bound on the posting date when the exact date is unknown (e.g. Workday "30+ days ago"). */
  postedBefore?: string | null;
  descriptionText: string | null;
  raw?: unknown;
}

export interface CompanyRef {
  id: number;
  name: string;
  careersUrl: string;
  atsType: AdapterKey;
  boardToken: string | null;
}

export interface SourceContext {
  http: HttpClient;
  signal?: AbortSignal;
  /** Collection window. Adapters may use it to skip work for postings that are certainly older. */
  range: { from: Date; to: Date };
  now: Date;
  /**
   * Optional: what the database already knows about a posting URL. Adapters that need an extra
   * request per posting for its date (iCIMS) use it to skip postings already stored.
   */
  lookupKnown?: (url: string) => { postedAt: string | null } | null;
}

export interface SourceAdapter {
  key: AdapterKey;
  label: string;
  detect(url: string): { boardToken: string } | null;
  /** All current postings for a company (includes descriptions when the API provides them). */
  listJobs(company: CompanyRef, ctx: SourceContext): Promise<RawJob[]>;
  /** Single-posting fetch, used for pasted links and the fetch ladder. */
  fetchJob?(url: string, ctx: SourceContext): Promise<RawJob>;
}
