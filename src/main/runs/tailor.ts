import type { JobStatus, TailorEstimate } from '@shared/results';
import { appEvents } from '../events';
import { redactSecrets } from '../redact';
import { runTask } from '../llm';
import { estimateTailor } from '../analysis/estimate';
import { jobPromptText } from '../analysis/pipeline';
import { getJobForAnalysis } from '../repos/analysis';
import { getProfile, getResume, getResumeFile } from '../repos/profiles';
import { listResults, markTailored } from '../repos/results';
import { getSettings } from '../repos/settings';
import { enqueueTailored, failTailored, getTailoredSummary, knownOriginalPages, saveTailored, setTailoredRunning, tailoredStates } from '../repos/tailored';
import { cleanList } from '../resume/parse';
import { applyEdits, classifyParagraphs, containsPhrase, readParagraphs, renderParagraphs, type DocxChange } from '../resume/docx';
import { docxToPdf, type WordPdfResult } from '../resume/wordPdf';
import { BudgetExceededError, pool } from './analyze';

/**
 * Tailored resumes (started from Results, never during analysis). For each job: the LLM rewrites the
 * editable paragraphs of the profile's active DOCX, the edits go into a copy of the file, and Word makes
 * the PDF. A failure only affects that job's row. LLM calls run in parallel; Word has its own queue.
 */

export interface TailorDeps {
  toPdf: (docx: Uint8Array) => Promise<WordPdfResult>;
  /** Resumes tailored in parallel; defaults to the Concurrency setting. */
  concurrency?: number;
}

const defaultDeps = (): TailorDeps => ({ toPdf: docxToPdf });

interface TailorSource {
  resumeId: number;
  docx: Uint8Array;
  editableIds: Set<number>;
  promptText: string;
  /** Shared by the jobs of a run, so they export the original once between them. */
  originalPages?: Promise<number>;
}

const errText = (e: unknown) => redactSecrets((e as Error)?.message ?? String(e));

/** The profile's active resume, ready to tailor. Throws with a message for the user when it can't be. */
async function loadSource(profileId: number): Promise<TailorSource> {
  const profile = getProfile(profileId);
  if (profile.activeResumeId == null) throw new Error(`${profile.name} has no active resume. Upload a DOCX to tailor it.`);
  const resume = getResume(profile.activeResumeId);
  if (resume.fileKind !== 'docx') {
    const kind = resume.fileKind === 'pasted' ? 'pasted text' : `a ${resume.fileKind === 'pdf' ? 'PDF' : 'text'} file`;
    throw new Error(`${profile.name}'s active resume is ${kind}. Tailoring keeps the original layout, so it needs a Word file: upload the resume as a DOCX.`);
  }
  if (!resume.structured) throw new Error(`${profile.name}'s resume hasn't been parsed yet. Wait for it to finish, or click Re-parse.`);
  const { blob } = getResumeFile(resume.id);
  if (!blob) throw new Error(`${profile.name}'s active resume has no file stored. Upload it again as a DOCX.`);
  const paragraphs = classifyParagraphs(await readParagraphs(blob), resume.structured);
  return {
    resumeId: resume.id,
    docx: blob,
    editableIds: new Set(paragraphs.filter((p) => p.editable).map((p) => p.id)),
    promptText: renderParagraphs(paragraphs),
  };
}

/** Which of these jobs would be tailored for this profile, and which are skipped and why. */
function partitionJobs(profileId: number, jobIds: number[]): { toTailor: number[]; alreadyTailored: number; notMatched: number } {
  const matched = new Set(listResults(profileId).rows.filter((r) => r.outcome === 'matched').map((r) => r.jobId));
  const states = tailoredStates(profileId);
  const toTailor: number[] = [];
  let alreadyTailored = 0;
  let notMatched = 0;
  for (const id of new Set(jobIds)) {
    const state = states.get(id);
    if (state && state !== 'failed') alreadyTailored++;
    else if (!matched.has(id)) notMatched++;
    else toTailor.push(id);
  }
  return { toTailor, alreadyTailored, notMatched };
}

export async function estimateTailorRun(profileId: number, jobIds: number[], now = new Date()): Promise<TailorEstimate> {
  const { toTailor, alreadyTailored, notMatched } = partitionJobs(profileId, jobIds);
  let resumeProblem: string | null = null;
  try {
    await loadSource(profileId);
  } catch (e) {
    resumeProblem = errText(e);
  }
  return { profileName: getProfile(profileId).name, resumeProblem, toTailor: toTailor.length, alreadyTailored, notMatched, ...estimateTailor(toTailor.length, now) };
}

/** What the review calls added: skills that really are in the applied text, and that the resume didn't already name. */
function reallyAdded(claimed: string[], changes: DocxChange[], resumeText: string): string[] {
  return cleanList(claimed).filter((skill) => changes.some((c) => containsPhrase(c.after, skill)) && !containsPhrase(resumeText, skill));
}

function emit(jobId: number, profileId: number, status: JobStatus | null = null): void {
  const summary = getTailoredSummary(jobId, profileId);
  if (summary) appEvents.emit('tailor:progress', { summary, status });
}

// Rows being worked on. Regenerating one of these would have two runs writing the same row.
const active = new Set<string>();
const activeKey = (jobId: number, profileId: number) => `${jobId}:${profileId}`;

/** The original's page count. Exporting it takes seconds and the file never changes, so it's only done once per resume version. */
function pagesOfOriginal(source: TailorSource, deps: TailorDeps): Promise<number> {
  const known = knownOriginalPages(source.resumeId);
  if (known != null) return Promise.resolve(known);
  source.originalPages ??= deps.toPdf(source.docx).then((r) => r.pages);
  return source.originalPages;
}

async function tailorOne(jobId: number, profileId: number, source: TailorSource, deps: TailorDeps): Promise<void> {
  try {
    setTailoredRunning(jobId, profileId);
    emit(jobId, profileId);
    const job = getJobForAnalysis(jobId);
    if (!job) throw new Error('Job not found');
    const res = await runTask('resume_tailor', { resume_paragraphs: source.promptText, job_text: jobPromptText(job) });
    const applied = await applyEdits(source.docx, res.data.edits, source.editableIds);
    if (applied.refusals.length) console.warn(`[tailor] job ${jobId}, profile ${profileId}: ${applied.changes.length} applied, refused ${applied.refusals.join('; ')}`);
    const pagesOriginal = await pagesOfOriginal(source, deps);
    const { pdf, pages } = await deps.toPdf(applied.docx);
    saveTailored(jobId, profileId, {
      resumeId: source.resumeId,
      changes: applied.changes,
      addedSkills: reallyAdded(res.data.added_skills, applied.changes, source.promptText),
      droppedEdits: applied.dropped,
      docx: applied.docx,
      pdf,
      pagesOriginal,
      pagesTailored: pages,
      promptVersionId: res.promptVersionId,
      modelId: res.model.id,
      modelName: res.usedFallback ? `${res.model.display_name} (fallback)` : res.model.display_name,
      costUsd: res.usage.costUsd,
    });
    emit(jobId, profileId, markTailored(profileId, jobId));
  } catch (e) {
    try {
      failTailored(jobId, profileId, errText(e));
      emit(jobId, profileId);
    } catch {
      // job or profile deleted meanwhile
    }
  } finally {
    active.delete(activeKey(jobId, profileId));
  }
}

/** Queue the jobs and start working through them in the background. `done` is for tests. */
export async function startTailor(
  input: { profileId: number; jobIds: number[]; budgetOverride: boolean },
  deps: TailorDeps = defaultDeps(),
): Promise<{ started: number; done: Promise<void> }> {
  const { profileId } = input;
  const source = await loadSource(profileId);
  const { toTailor } = partitionJobs(profileId, input.jobIds);
  if (!toTailor.length) return { started: 0, done: Promise.resolve() };
  const est = estimateTailor(toTailor.length, new Date());
  if (est.exceedsBudget && !input.budgetOverride) {
    throw new BudgetExceededError(
      `This (~$${est.totalUsd.toFixed(2)}) would take this month's spend to $${(est.monthSpentUsd + est.totalUsd).toFixed(2)}, over your $${est.monthlyBudgetUsd.toFixed(2)} budget.`,
    );
  }
  for (const jobId of toTailor) {
    active.add(activeKey(jobId, profileId));
    enqueueTailored(jobId, profileId, source.resumeId);
    emit(jobId, profileId);
  }
  const done = pool(toTailor, deps.concurrency ?? getSettings().concurrency, (jobId) => tailorOne(jobId, profileId, source, deps));
  return { started: toTailor.length, done };
}

/** Tailor one job again, for the profile's active resume. The link stays; the old file is served until the new one is saved. */
export async function regenerateTailored(profileId: number, jobId: number, deps: TailorDeps = defaultDeps()): Promise<{ done: Promise<void> }> {
  if (active.has(activeKey(jobId, profileId))) throw new Error('This resume is already being tailored.');
  const source = await loadSource(profileId);
  if (!listResults(profileId).rows.some((r) => r.jobId === jobId && r.outcome === 'matched')) throw new Error('Only matched jobs can be tailored.');
  active.add(activeKey(jobId, profileId));
  enqueueTailored(jobId, profileId, source.resumeId);
  emit(jobId, profileId);
  return { done: tailorOne(jobId, profileId, source, deps) };
}
