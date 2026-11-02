/** Job list types and source labels shared by main and renderer. */

import type { Verdict } from './scoring';

export const FETCH_STATUSES = ['pending', 'fetched', 'unreadable', 'manual_text'] as const;
export type FetchStatus = (typeof FETCH_STATUSES)[number];

export const FETCH_STATUS_LABELS: Record<FetchStatus, string> = {
  pending: 'Not fetched yet',
  fetched: 'Fetched',
  unreadable: 'Needs manual paste',
  manual_text: 'Manual text',
};

/** A profile this job was analyzed for, from its latest analysis for that profile. */
export interface JobProfileAnalysis {
  profileId: number;
  profileName: string;
  /** scored = matched; filtered = failed a hard filter; skipped = below the pre-score threshold. */
  status: 'scored' | 'filtered' | 'skipped';
  /** Total with the current weights (scored only). */
  score: number | null;
  verdict: Verdict | null;
}

/** Source key of jobs saved from a description alone, with no link. */
export const DESCRIPTION_SOURCE_KEY = 'description';

/** The link to show for a job: none for a description-only job (its stored URL is just a key). */
export function jobLink(sourceKey: string, canonicalUrl: string): string | null {
  return sourceKey === DESCRIPTION_SOURCE_KEY ? null : canonicalUrl;
}

export interface JobListItem {
  id: number;
  /** null for a job saved from its description alone. */
  url: string | null;
  sourceKey: string;
  sourceLabel: string;
  companyId: number | null;
  companyName: string | null;
  title: string | null;
  location: string | null;
  postedAt: string | null;
  /** source | source_republish | relative | first_seen */
  postedAtSource: string;
  firstSeenAt: string;
  lastSeenAt: string | null;
  fetchStatus: FetchStatus;
  hasDescription: boolean;
  isClosed: boolean;
  closedReason: string | null;
  /** Why the fetch ladder couldn't read the page (fetch status "unreadable"). */
  fetchError: string | null;
  /** Other URLs that were merged into this job (dedupe). */
  extraUrls: string[];
  /** When the link or description was last pasted (new or already saved); null for jobs from older collection runs. */
  lastAddedAt: string | null;
  /** Profiles this job has been analyzed for, by profile name. */
  analyses: JobProfileAnalysis[];
}

/** A job waiting for a pasted description, with the profiles it was queued (or analyzed) for. */
export interface NeedsPasteJob extends JobListItem {
  profileIds: number[];
}

export interface AddDescriptionResult {
  job: JobListItem;
  /** The description (or its link) was already saved; that job was updated instead. */
  duplicate: boolean;
}

export interface AddLinksResult {
  added: JobListItem[];
  duplicates: { input: string; url: string; jobId: number | null; reason: 'already_saved' | 'repeated_in_paste' | 'same_job' }[];
  invalid: { input: string; reason: string }[];
}

const ATS_LABELS: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  icims: 'iCIMS',
  generic: 'Company site',
};

const PLATFORM_LABELS: Record<string, string> = {
  'linkedin.com': 'LinkedIn',
  'jobright.ai': 'Jobright',
  'welcometothejungle.com': 'Welcome to the Jungle',
  'app.welcometothejungle.com': 'Welcome to the Jungle',
  'indeed.com': 'Indeed',
  'glassdoor.com': 'Glassdoor',
  'wellfound.com': 'Wellfound',
  'builtin.com': 'Built In',
  'workatastartup.com': 'Work at a Startup (YC)',
  'ycombinator.com': 'Y Combinator',
  'otta.com': 'Otta',
  'dice.com': 'Dice',
  'ziprecruiter.com': 'ZipRecruiter',
  'monster.com': 'Monster',
  'simplyhired.com': 'SimplyHired',
  'remoteok.com': 'Remote OK',
  'weworkremotely.com': 'We Work Remotely',
  'hired.com': 'Hired',
};

/** "greenhouse" → "Greenhouse", "manual:linkedin.com" → "LinkedIn", "manual:foo.com" → "foo.com". */
export function sourceLabel(sourceKey: string): string {
  if (sourceKey === DESCRIPTION_SOURCE_KEY) return 'Pasted description';
  if (ATS_LABELS[sourceKey]) return ATS_LABELS[sourceKey];
  const domain = sourceKey.startsWith('manual:') ? sourceKey.slice('manual:'.length) : sourceKey;
  return PLATFORM_LABELS[domain] ?? domain;
}
