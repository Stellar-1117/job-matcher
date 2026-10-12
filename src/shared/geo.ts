/**
 * Country/region names used by job extraction (normalisation) and the location hard filter.
 * Only aliases that are unambiguous are listed; anything unrecognised is kept as written.
 */

const COUNTRY_ALIASES: Record<string, string> = {
  us: 'United States',
  usa: 'United States',
  'u.s.': 'United States',
  'u.s.a.': 'United States',
  'united states': 'United States',
  'united states of america': 'United States',
  uk: 'United Kingdom',
  'u.k.': 'United Kingdom',
  'united kingdom': 'United Kingdom',
  'great britain': 'United Kingdom',
  britain: 'United Kingdom',
  england: 'United Kingdom',
  scotland: 'United Kingdom',
  wales: 'United Kingdom',
  'northern ireland': 'United Kingdom',
  uae: 'United Arab Emirates',
  'united arab emirates': 'United Arab Emirates',
  deutschland: 'Germany',
  holland: 'Netherlands',
  'the netherlands': 'Netherlands',
  nederland: 'Netherlands',
  españa: 'Spain',
  espana: 'Spain',
  'south korea': 'South Korea',
  'republic of korea': 'South Korea',
  korea: 'South Korea',
  czechia: 'Czech Republic',
  'czech republic': 'Czech Republic',
  türkiye: 'Turkey',
  turkiye: 'Turkey',
};

const titleCase = (s: string) => s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** "USA" → "United States", "germany" → "Germany"; null/blank → null. */
export function canonicalCountry(name: string | null | undefined): string | null {
  const v = name?.trim().replace(/\s+/g, ' ');
  if (!v) return null;
  const alias = COUNTRY_ALIASES[v.toLowerCase()];
  if (alias) return alias;
  return v === v.toUpperCase() && v.length > 3 ? titleCase(v) : v.length <= 3 ? v.toUpperCase() : v[0].toUpperCase() + v.slice(1);
}

export function sameCountry(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = canonicalCountry(a);
  const y = canonicalCountry(b);
  return !!x && !!y && x.toLowerCase() === y.toLowerCase();
}

const EUROPE = [
  'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany',
  'Greece', 'Hungary', 'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Luxembourg', 'Malta', 'Netherlands', 'Poland', 'Portugal',
  'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Norway', 'Switzerland', 'Iceland', 'United Kingdom', 'Serbia', 'Ukraine',
];
const EU_ONLY = EUROPE.filter((c) => !['Norway', 'Switzerland', 'Iceland', 'United Kingdom', 'Serbia', 'Ukraine'].includes(c));
const NORTH_AMERICA = ['United States', 'Canada', 'Mexico'];
const LATAM = ['Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia', 'Peru', 'Uruguay', 'Costa Rica', 'Ecuador', 'Bolivia', 'Paraguay', 'Guatemala', 'Panama'];
const APAC = ['Australia', 'New Zealand', 'Japan', 'Singapore', 'India', 'China', 'South Korea', 'Hong Kong', 'Taiwan', 'Philippines', 'Indonesia', 'Vietnam', 'Thailand', 'Malaysia'];
const MIDDLE_EAST_AFRICA = ['Israel', 'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Egypt', 'South Africa', 'Nigeria', 'Kenya', 'Morocco', 'Turkey'];
export const ANYWHERE = '*';

/** Region words that may appear in a remote job's region restriction. Longest phrases are matched first. */
const REGIONS: [string, string[]][] = [
  ['worldwide', [ANYWHERE]],
  ['anywhere', [ANYWHERE]],
  ['global', [ANYWHERE]],
  ['international', [ANYWHERE]],
  ['north america', NORTH_AMERICA],
  ['latin america', LATAM],
  ['south america', LATAM],
  ['latam', LATAM],
  ['americas', [...NORTH_AMERICA, ...LATAM]],
  ['european union', EU_ONLY],
  ['europe', EUROPE],
  ['eea', [...EU_ONLY, 'Norway', 'Iceland']],
  ['emea', [...EUROPE, ...MIDDLE_EAST_AFRICA]],
  ['eu', EU_ONLY],
  ['asia pacific', APAC],
  ['apac', APAC],
  ['asia', APAC],
  ['oceania', ['Australia', 'New Zealand']],
  ['anz', ['Australia', 'New Zealand']],
  ['dach', ['Germany', 'Austria', 'Switzerland']],
  ['nordics', ['Denmark', 'Finland', 'Norway', 'Sweden', 'Iceland']],
  ['benelux', ['Belgium', 'Netherlands', 'Luxembourg']],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, 'iu');

/**
 * Countries a remote region restriction allows ("US only" → United States, "EU time zones" → EU),
 * `[ANYWHERE]` for worldwide, or null when nothing in the text is recognised.
 */
export function countriesInRegion(region: string | null | undefined): string[] | null {
  if (!region?.trim()) return null;
  const text = region.toLowerCase();
  const found = new Set<string>();
  for (const [word, list] of REGIONS) if (wordRe(word).test(text)) list.forEach((c) => found.add(c));
  for (const [alias, country] of Object.entries(COUNTRY_ALIASES)) {
    // Two-letter aliases ("us", "uk") only count in upper case ("US only"), not as English words.
    if (alias.length <= 2 ? new RegExp(`(?<![A-Za-z])${alias.toUpperCase()}(?![A-Za-z])`).test(region) : wordRe(alias).test(text)) found.add(country);
  }
  const all = new Set([...EUROPE, ...NORTH_AMERICA, ...LATAM, ...APAC, ...MIDDLE_EAST_AFRICA]);
  for (const c of all) if (wordRe(c.toLowerCase()).test(text)) found.add(c);
  if (found.has(ANYWHERE)) return [ANYWHERE];
  return found.size ? [...found] : null;
}
