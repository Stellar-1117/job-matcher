/**
 * Site sessions and the "human pass": pages the hidden browser couldn't read because the site asked
 * for a person (a bot check / CAPTCHA, or a sign-in) wait in a queue, and the user goes through them
 * together in a visible window after the automatic fetching is done. Cookies are kept on disk, so
 * a sign-in or a passed check carries over to later runs.
 */

/** Why a page needs a person: a bot check (Cloudflare, CAPTCHA…) or a sign-in. */
export const FETCH_BLOCKS = ['bot_check', 'login'] as const;
export type FetchBlock = (typeof FETCH_BLOCKS)[number];

export const FETCH_BLOCK_LABELS: Record<FetchBlock, string> = {
  bot_check: 'Bot check',
  login: 'Sign-in',
};

export interface HumanPassJob {
  jobId: number;
  title: string | null;
  companyName: string | null;
  url: string;
  host: string;
  block: FetchBlock;
}

/** How many windows the human pass opens side by side (the user works through them in turn). */
export const PASS_WINDOWS_DEFAULT = 4;
export const PASS_WINDOWS_MAX = 6;

/** One window of the human pass. */
export interface HumanPassSlot {
  /** 1-based, as shown in the window's title. */
  window: number;
  /** null while the window waits for a site another window is on. */
  current: HumanPassJob | null;
  /** What the window is waiting for, shown under its link. */
  hint: string | null;
}

export interface HumanPassState {
  active: boolean;
  total: number;
  /** Links finished so far (read, closed or skipped). */
  finished: number;
  read: number;
  closed: number;
  skipped: number;
  slots: HumanPassSlot[];
  /** Analysis run resumed after the pass, if any. */
  resumedRunId: number | null;
}

export interface SiteSession {
  /** Registrable domain the cookies belong to, e.g. "ziprecruiter.com". */
  domain: string;
  cookies: number;
  /** Latest cookie expiry (ISO), or null when they are all session cookies. */
  expiresAt: string | null;
}

/** Sites with a known sign-in page (the page also links to sign-up for a new account). */
export const SIGN_IN_SITES: { label: string; url: string }[] = [
  { label: 'ZipRecruiter', url: 'https://www.ziprecruiter.com/authn/login' },
  { label: 'LinkedIn', url: 'https://www.linkedin.com/login' },
  { label: 'Indeed', url: 'https://secure.indeed.com/auth' },
  { label: 'Glassdoor', url: 'https://www.glassdoor.com/profile/login_input.htm' },
];
