import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderResponse } from '../src/main/llm/types';

// Scripted LLM: each call pops the next response.
let script: (() => ProviderResponse | Error)[] = [];
const fake = {
  async complete(): Promise<ProviderResponse> {
    const step = script.shift();
    if (!step) throw new Error('unexpected LLM call');
    const out = step();
    if (out instanceof Error) throw out;
    return out;
  },
  async test() {
    return 'ok';
  },
};
vi.mock('../src/main/llm/anthropic', () => ({ anthropicAdapter: fake }));
vi.mock('../src/main/llm/openai-compat', () => ({ makeOpenAICompatAdapter: () => fake }));

const { setupTestDb } = await import('./helpers');
const { setKey } = await import('../src/main/repos/keys');
const repo = await import('../src/main/repos/profiles');
const { parseResume, cleanParsed } = await import('../src/main/resume/parse');
const { profileTemplateVars, renderSoftPreferences } = await import('../src/main/resume/vars');
const { DEFAULT_PREFERENCES, parsePreferences, PreferencesSchema } = await import('@shared/profile');
const { appEvents } = await import('../src/main/events');

const PARSED = {
  name: ' Jordan Lee ',
  headline: 'Backend Engineer',
  total_years_experience: 8,
  skills: ['Go', 'go', 'PostgreSQL', ' '],
  roles: [{ title: 'Senior Engineer', company: 'PayFlow', start: '2019', end: 'present', summary: 'Ledger service' }],
  projects: [{ name: 'Ledger', role: 'Lead', what_built: 'Double-entry ledger', scale_impact: '2M tx/day', technologies: ['Go', 'Kafka'], domain: 'payments' }],
  domains: ['payments'],
  education: [{ degree: 'BSc CS', institution: 'MIT', year: '2014' }, { degree: null, institution: '', year: null }],
  languages: ['English', 'Spanish'],
};
const ok = (data: unknown): ProviderResponse => ({ text: JSON.stringify(data), usage: { uncachedInput: 100, cacheWrite: 0, cachedInput: 0, output: 50 }, stopReason: 'end_turn' });
const RESUME_TEXT = 'Jordan Lee — Backend Engineer. PayFlow 2019–present: built a ledger service in Go.';

beforeEach(() => {
  setupTestDb();
  script = [];
  setKey({ provider: 'anthropic', key: 'an-key-2222' });
});

describe('profiles', () => {
  it('creates profiles with default preferences; rename and delete', () => {
    const id = repo.createProfile('  Alex  ');
    const p = repo.getProfile(id);
    expect(p).toMatchObject({ name: 'Alex', activeResumeId: null, resumes: [] });
    expect(p.preferences).toEqual(DEFAULT_PREFERENCES);
    repo.renameProfile(id, 'Alex K');
    expect(repo.listProfiles().map((x) => x.name)).toEqual(['Alex K']);
    repo.deleteProfile(id);
    expect(repo.listProfiles()).toEqual([]);
  });

  it('saves and reloads preferences', () => {
    const id = repo.createProfile('A');
    const prefs = structuredClone(DEFAULT_PREFERENCES);
    prefs.hard.visa = { enabled: true, needsSponsorship: true };
    prefs.hard.seniority = { enabled: true, min: 'Mid', max: 'Staff/Principal' };
    prefs.soft.targetFunctions = ['Backend'];
    repo.savePreferences(id, PreferencesSchema.parse(prefs));
    expect(repo.getProfile(id).preferences).toEqual(prefs);
  });

  it('parses old/partial preference JSON with defaults for missing fields', () => {
    const p = parsePreferences(JSON.stringify({ hard: { visa: { enabled: true } }, soft: { notes: 'hi' } }));
    expect(p.hard.visa).toEqual({ enabled: true, needsSponsorship: false });
    expect(p.hard.salary).toEqual(DEFAULT_PREFERENCES.hard.salary);
    expect(p.soft.notes).toBe('hi');
    expect(parsePreferences('not json')).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('resume versions', () => {
  it('each upload creates a new version that becomes active', () => {
    const pid = repo.createProfile('A');
    const r1 = repo.createResume(pid, { fileName: 'cv.pdf', kind: 'pdf', blob: new Uint8Array([1]), text: 'v1 text' });
    const r2 = repo.createResume(pid, { fileName: 'cv2.docx', kind: 'docx', blob: new Uint8Array([2]), text: 'v2 text' });
    const p = repo.getProfile(pid);
    expect(p.activeResumeId).toBe(r2);
    expect(p.resumes.map((r) => [r.version, r.isActive])).toEqual([
      [2, true],
      [1, false],
    ]);
    repo.setActiveResume(r1);
    expect(repo.getProfile(pid).activeResumeId).toBe(r1);
    // Deleting the active version falls back to the newest remaining one.
    repo.deleteResume(r1);
    expect(repo.getProfile(pid).activeResumeId).toBe(r2);
    repo.deleteResume(r2);
    expect(repo.getProfile(pid).activeResumeId).toBeNull();
  });

  it('keeps the original file bytes', () => {
    const pid = repo.createProfile('A');
    const rid = repo.createResume(pid, { fileName: 'cv.pdf', kind: 'pdf', blob: new Uint8Array([37, 80, 68, 70]), text: 't' });
    expect([...repo.getResumeFile(rid).blob!]).toEqual([37, 80, 68, 70]);
  });
});

describe('parseResume', () => {
  it('stores the cleaned structured profile with model + prompt version, and emits events', async () => {
    const pid = repo.createProfile('A');
    const rid = repo.createResume(pid, { fileName: 'cv.txt', kind: 'txt', blob: null, text: RESUME_TEXT });
    const events: string[] = [];
    const listener = (e: { status: string }) => events.push(e.status);
    appEvents.on('resume:updated', listener);
    script = [() => ok(PARSED)];
    await parseResume(rid);
    appEvents.off('resume:updated', listener);

    const r = repo.getResume(rid);
    expect(r.parseStatus).toBe('done');
    expect(r.structured).toEqual(cleanParsed(PARSED as any));
    expect(r.structured!.skills).toEqual(['Go', 'PostgreSQL']);
    expect(r.structured!.name).toBe('Jordan Lee');
    expect(r.structured!.education).toHaveLength(1);
    expect(r.modelName).toBe('Claude Sonnet 5');
    expect(r.promptVersion).toBe(1);
    expect(events).toEqual(['parsing', 'done']);
  });

  it('marks the resume failed with the error message', async () => {
    const pid = repo.createProfile('A');
    const rid = repo.createResume(pid, { fileName: 'cv.txt', kind: 'txt', blob: null, text: RESUME_TEXT });
    script = [() => ok({ nope: true }), () => ok({ still: 'bad' })];
    await parseResume(rid);
    const r = repo.getResume(rid);
    expect(r.parseStatus).toBe('failed');
    expect(r.parseError).toMatch(/validation/);
  });

  it('manual edits are kept separately and can be reverted; re-parse overwrites', async () => {
    const pid = repo.createProfile('A');
    const rid = repo.createResume(pid, { fileName: 'cv.txt', kind: 'txt', blob: null, text: RESUME_TEXT });
    script = [() => ok(PARSED)];
    await parseResume(rid);
    const edited = { ...repo.getResume(rid).structured!, headline: 'Staff Engineer', skills: ['Go', 'Rust'] };
    repo.saveStructured(rid, edited);
    let r = repo.getResume(rid);
    expect(r.edited).toBe(true);
    expect(r.structured!.headline).toBe('Staff Engineer');
    expect(r.structuredParsed!.headline).toBe('Backend Engineer');
    repo.revertStructured(rid);
    r = repo.getResume(rid);
    expect(r.edited).toBe(false);
    expect(r.structured!.headline).toBe('Backend Engineer');
  });

  it('fails interrupted parses on startup', () => {
    const pid = repo.createProfile('A');
    const rid = repo.createResume(pid, { fileName: 'cv.txt', kind: 'txt', blob: null, text: RESUME_TEXT });
    repo.setParseStatus(rid, 'parsing', null);
    expect(repo.failInterruptedParses()).toBe(1);
    expect(repo.getResume(rid)).toMatchObject({ parseStatus: 'failed' });
  });
});

describe('profile template variables', () => {
  it('renders soft preferences with only set values', () => {
    const prefs = structuredClone(DEFAULT_PREFERENCES);
    expect(renderSoftPreferences(prefs)).toBe('No stated preferences.');
    prefs.soft.targetFunctions = ['Backend'];
    prefs.soft.notes = ' Prefer small teams ';
    prefs.hard.salary = { enabled: true, min: 150000, currency: 'USD', period: 'year' };
    prefs.hard.workModes = { enabled: false, allowed: ['Remote'] };
    expect(JSON.parse(renderSoftPreferences(prefs))).toEqual({
      target_functions: ['Backend'],
      minimum_salary: '150000 USD per year',
      notes: 'Prefer small teams',
    });
  });

  it('requires a parsed active resume', async () => {
    const pid = repo.createProfile('Sam');
    expect(() => profileTemplateVars(pid)).toThrow(/no resume/);
    const rid = repo.createResume(pid, { fileName: 'cv.txt', kind: 'txt', blob: null, text: RESUME_TEXT });
    expect(() => profileTemplateVars(pid)).toThrow(/parsed/);
    script = [() => ok(PARSED)];
    await parseResume(rid);
    const { vars, resumeId } = profileTemplateVars(pid);
    expect(resumeId).toBe(rid);
    expect(vars.resume_text).toBe(RESUME_TEXT);
    expect(JSON.parse(vars.profile_structured!).name).toBe('Jordan Lee');
  });
});
