import type { AnalyzeEstimate, AnalyzeParams, TaskEstimate } from '@shared/analysis';
import { evaluateHardFilters } from '@shared/hardFilters';
import { sourceLabel } from '@shared/jobs';
import { getSettings } from '../repos/settings';
import { getModel } from '../repos/models';
import { getActivePrompt } from '../repos/prompts';
import { getRoute } from '../repos/routes';
import { getProfile } from '../repos/profiles';
import { averageUsage, findAnalysis, findExtraction, getJobForAnalysis, listCandidateRows, monthSpend, type CandidateJob } from '../repos/analysis';
import { jobInDateRange, resolveDateRange } from '@shared/dates';
import { jobPromptText, loadProfileContext, type ProfileContext } from './pipeline';

/** Built-in token assumptions per call when there's no usage history yet (§5). */
export const DEFAULT_TOKENS: Record<TaskEstimate['task'], { input: number; output: number }> = {
  job_extraction: { input: 2500, output: 400 },
  pre_score: { input: 1500, output: 150 },
  matching: { input: 5000, output: 900 },
};

/** History needs a few calls before it's a better guess than the defaults. */
const MIN_HISTORY_CALLS = 3;

/** Jobs a run would cover: explicit ids, or not-closed jobs inside the date range from the chosen sources. */
export function selectCandidates(params: AnalyzeParams, now: Date): { inRange: CandidateJob[]; selected: CandidateJob[] } {
  if (params.jobIds) {
    const rows = listCandidateRows(params.jobIds).filter((j) => !j.isClosed);
    return { inRange: rows, selected: rows };
  }
  const range = resolveDateRange(params.dateRange, now);
  const inRange = listCandidateRows(null).filter((j) => !j.isClosed && jobInDateRange(j, range, params.dateField));
  const keys = new Set(params.sourceKeys);
  const selected = keys.size ? inRange.filter((j) => keys.has(j.sourceKey)) : inRange;
  return { inRange, selected };
}

function taskEstimate(task: TaskEstimate['task'], calls: number): TaskEstimate {
  const route = getRoute(task);
  const modelId = route?.model_id ?? route?.fallback_model_id ?? null;
  const model = modelId != null ? getModel(modelId) : null;
  const hist = model ? averageUsage(task, model.id) : null;
  const useHistory = !!hist && hist.calls >= MIN_HISTORY_CALLS;
  const input = useHistory ? hist!.input : DEFAULT_TOKENS[task].input;
  const cached = useHistory ? hist!.cached : 0;
  const output = useHistory ? hist!.output : DEFAULT_TOKENS[task].output;
  const perCall = model ? (input * model.price_in + cached * model.price_cache_read + output * model.price_out) / 1_000_000 : 0;
  return {
    task,
    calls,
    model: model?.display_name ?? null,
    inputTokens: Math.round(input),
    outputTokens: Math.round(output),
    cachedTokens: Math.round(cached),
    basis: useHistory ? 'history' : 'default',
    costUsd: perCall * calls,
  };
}

/**
 * What a run would do and cost (§5 "Before running"): jobs needing extraction, job × profile pairs
 * needing matching (cached pairs and known hard-filter failures are free), priced with average token
 * counts from the usage log, checked against the monthly budget.
 */
export function estimateAnalyze(params: AnalyzeParams, now: Date): AnalyzeEstimate {
  const settings = getSettings();
  const { inRange, selected } = selectCandidates(params, now);

  const profiles: ProfileContext[] = [];
  const profileProblems: AnalyzeEstimate['profileProblems'] = [];
  for (const id of params.profileIds) {
    try {
      profiles.push(loadProfileContext(id));
    } catch (e) {
      let name = 'Deleted profile';
      try {
        name = getProfile(id).name;
      } catch {
        // deleted meanwhile
      }
      profileProblems.push({ profileId: id, name, problem: (e as Error).message });
    }
  }

  const extractionPrompt = getActivePrompt('job_extraction');
  const extractionRoute = getRoute('job_extraction');
  const extractionModel = extractionRoute?.model_id ?? extractionRoute?.fallback_model_id ?? null;
  const matchingPrompt = getActivePrompt('matching');
  const matchingRoute = getRoute('matching');
  const matchingModel = matchingRoute?.model_id ?? matchingRoute?.fallback_model_id ?? null;

  let needFetch = 0;
  let needPaste = 0;
  let needExtraction = 0;
  let needMatching = 0;
  let cached = 0;
  let hardFiltered = 0;

  for (const j of selected) {
    if (!j.hasDescription && j.fetchStatus === 'unreadable') {
      needPaste++;
      continue;
    }
    if (!j.hasDescription) needFetch++;
    const ex = extractionPrompt && extractionModel != null ? findExtraction(j.id, extractionPrompt.id, extractionModel) : null;
    if (!ex) needExtraction++;
    const job = ex ? getJobForAnalysis(j.id) : null;
    for (const p of profiles) {
      if (ex && job) {
        const hard = evaluateHardFilters(p.hard, ex.fields, jobPromptText(job), settings.taxonomy.seniority);
        if (!hard.pass) {
          hardFiltered++;
          continue;
        }
      }
      const existing =
        !params.reanalyze && matchingPrompt && matchingModel != null
          ? findAnalysis({ jobId: j.id, profileId: p.profileId, resumeId: p.resumeId, promptVersionId: matchingPrompt.id, modelId: matchingModel })
          : null;
      const preSkipValid =
        existing?.outcome === 'pre_score_skip' && settings.preScore.enabled && existing.preScore != null && existing.preScore < settings.preScore.threshold;
      if (existing && (existing.hasMatch || preSkipValid)) cached++;
      else needMatching++;
    }
  }

  const tasks: TaskEstimate[] = [taskEstimate('job_extraction', needExtraction)];
  if (settings.preScore.enabled) tasks.push(taskEstimate('pre_score', needMatching));
  tasks.push(taskEstimate('matching', needMatching));
  const totalUsd = tasks.reduce((s, t) => s + t.costUsd, 0);
  const spent = monthSpend(now);
  const cap = settings.monthlyBudgetUsd;

  const counts = new Map<string, number>();
  for (const j of inRange) counts.set(j.sourceKey, (counts.get(j.sourceKey) ?? 0) + 1);
  const sources = [...counts.entries()]
    .map(([key, count]) => ({ key, label: sourceLabel(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    jobs: selected.length,
    profiles: profiles.length,
    needFetch,
    needPaste,
    needExtraction,
    needMatching,
    cached,
    hardFiltered,
    tasks,
    totalUsd,
    monthSpentUsd: spent,
    monthlyBudgetUsd: cap,
    exceedsBudget: cap > 0 && spent + totalUsd > cap,
    profileProblems,
    sources,
  };
}
