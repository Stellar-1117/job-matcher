import { useEffect, useState } from 'react';
import type { ResultDetail, ResultsList, JobStatus } from '@shared/results';
import { JOB_STATUSES, JOB_STATUS_LABELS } from '@shared/results';
import { SUB_SCORE_KEYS, SUB_SCORE_LABELS, type Weights } from '@shared/scoring';
import type { ScoredRow } from '@shared/resultFilters';
import { invoke } from '../../api';
import { Badge, Button, ErrorBox, Input, Select, Spinner, cx } from '../../components/ui';
import { formatSalary } from '../../components/format';

const SEVERITY_TONES = { high: 'red', medium: 'amber', low: 'slate' } as const;
const FILTER_ICONS = { pass: '✓', fail: '✗', unknown: '?', off: '–' } as const;
const FILTER_COLORS = { pass: 'text-emerald-600', fail: 'text-red-600', unknown: 'text-slate-500', off: 'text-slate-300' } as const;

export function scoreColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 65) return 'bg-sky-500';
  if (score >= 50) return 'bg-amber-400';
  return 'bg-slate-300';
}

function Field({ label, value }: { label: string; value: string | number | null | undefined | string[] }) {
  const text = Array.isArray(value) ? value.join(', ') : value;
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={cx('text-xs', text == null || text === '' ? 'text-slate-400' : 'text-slate-700')}>{text == null || text === '' ? '—' : text}</div>
    </div>
  );
}

export default function ResultDetailPanel({
  row,
  list,
  weights,
  feedbackEnabled,
  onStatus,
  onReanalyze,
  onFeedback,
}: {
  row: ScoredRow;
  list: ResultsList;
  weights: Weights;
  feedbackEnabled: boolean;
  onStatus: (s: JobStatus) => void;
  onReanalyze: () => void;
  onFeedback: (feedback: -1 | 0 | 1, note: string | null) => void;
}) {
  const [detail, setDetail] = useState<ResultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState(row.feedbackNote ?? '');

  useEffect(() => {
    let stale = false;
    invoke('results:detail', { analysisId: row.analysisId })
      .then((d) => !stale && setDetail(d))
      .catch((e) => !stale && setError((e as Error).message));
    return () => {
      stale = true;
    };
  }, [row.analysisId]);

  const differentModel = list.currentModelId != null && row.modelId !== list.currentModelId;
  const differentPrompt = list.currentPromptVersion != null && row.promptVersion != null && row.promptVersion !== list.currentPromptVersion;
  const wsum = SUB_SCORE_KEYS.reduce((s, k) => s + weights[k], 0) || 1;
  const f = detail?.fields;

  return (
    <div className="border-t border-indigo-100 bg-indigo-50/30 px-4 py-3" onClick={(e) => e.stopPropagation()}>
      <ErrorBox error={error} />
      {!detail && !error && <Spinner />}
      {detail && (
        <div className="flex flex-col gap-3">
          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <a href={row.url} target="_blank" rel="noreferrer" className="rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
              Open link ↗
            </a>
            <Button size="sm" onClick={onReanalyze} title="Run matching again for this job and profile (costs one LLM call)">
              Re-analyze
            </Button>
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              Status
              <Select value={row.status} onChange={(e) => onStatus(e.target.value as JobStatus)} className="py-0.5 text-xs">
                {JOB_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {JOB_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </label>
            {feedbackEnabled && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  title="Good match"
                  className={cx('rounded px-1.5 py-0.5 text-sm', row.feedback === 1 ? 'bg-emerald-100 ring-1 ring-emerald-400' : 'hover:bg-slate-100')}
                  onClick={() => onFeedback(row.feedback === 1 ? 0 : 1, note || null)}
                >
                  👍
                </button>
                <button
                  type="button"
                  title="Bad match"
                  className={cx('rounded px-1.5 py-0.5 text-sm', row.feedback === -1 ? 'bg-red-100 ring-1 ring-red-400' : 'hover:bg-slate-100')}
                  onClick={() => onFeedback(row.feedback === -1 ? 0 : -1, note || null)}
                >
                  👎
                </button>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onBlur={() => note !== (row.feedbackNote ?? '') && onFeedback(row.feedback, note || null)}
                  placeholder="Feedback note (optional)"
                  className="w-56 py-0.5 text-xs"
                />
              </div>
            )}
            <span className="ml-auto text-[11px] text-slate-500">
              {detail.modelName ?? 'Unknown model'} · matching prompt v{detail.promptVersion ?? '?'} · resume v{detail.resumeVersion ?? '?'} · {new Date(detail.analyzedAt).toLocaleString()}
              {detail.costUsd > 0 && ` · $${detail.costUsd.toFixed(4)}`}
            </span>
          </div>
          {(differentModel || differentPrompt || !row.currentResume) && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
              {differentModel && <div>Different model: analyzed with {row.modelName ?? 'another model'}, but matching now uses {list.currentModelName ?? 'another model'}. Re-analyze to compare like with like.</div>}
              {differentPrompt && <div>Analyzed with matching prompt v{row.promptVersion}; the active prompt is v{list.currentPromptVersion}.</div>}
              {!row.currentResume && <div>Analyzed with an older resume version.</div>}
            </div>
          )}
          {row.isClosed && <div className="text-xs text-red-700">Closed: {row.closedReason}</div>}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_1fr]">
            <div className="flex flex-col gap-3">
              {detail.summary && <p className="text-sm font-medium text-slate-800">{detail.summary}</p>}
              {detail.preScore != null && (
                <p className="text-xs text-slate-600">
                  Pre-score {detail.preScore}
                  {detail.preScoreReason ? ` — ${detail.preScoreReason}` : ''}
                </p>
              )}
              {detail.subScores && (
                <div className="flex flex-col gap-1.5">
                  {SUB_SCORE_KEYS.map((k) => {
                    const s = detail.subScores![k];
                    return (
                      <div key={k} className="grid grid-cols-[9rem_2.5rem_6rem_1fr] items-start gap-2 text-xs">
                        <span className="text-slate-600">
                          {SUB_SCORE_LABELS[k]} <span className="text-slate-400">×{Math.round((weights[k] / wsum) * 100)}%</span>
                        </span>
                        <span className="text-right font-semibold tabular-nums">{s.score}</span>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
                          <div className={cx('h-full', scoreColor(s.score))} style={{ width: `${s.score}%` }} />
                        </div>
                        <span className="text-slate-600">{s.reason}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {detail.strengths.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Strengths</div>
                  <ul className="flex flex-col gap-1 text-xs">
                    {detail.strengths.map((s, i) => (
                      <li key={i}>
                        <span className="text-slate-800">{s.point}</span>
                        {s.resume_evidence && <span className="ml-1 italic text-slate-500">“{s.resume_evidence}”</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {detail.gaps.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-red-700">Gaps</div>
                  <ul className="flex flex-col gap-1 text-xs">
                    {detail.gaps.map((g, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <Badge tone={SEVERITY_TONES[g.severity]}>{g.severity}</Badge>
                        <span className="text-slate-800">{g.point}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Hard filters</div>
                <ul className="grid grid-cols-1 gap-0.5 text-xs">
                  {detail.hardFilters.map((h) => (
                    <li key={h.key} className="flex gap-1.5">
                      <span className={cx('w-3 font-bold', FILTER_COLORS[h.status])}>{FILTER_ICONS[h.status]}</span>
                      <span className={cx('w-32 shrink-0', h.status === 'off' ? 'text-slate-400' : 'text-slate-700')}>{h.label}</span>
                      <span className={h.status === 'fail' ? 'text-red-700' : 'text-slate-500'}>{h.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {f && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Job fields <span className="font-normal normal-case text-slate-400">({detail.extractionModel ?? 'extraction'})</span>
                  </div>
                  <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
                    <Field label="Function" value={f.job_function} />
                    <Field label="Seniority" value={f.seniority} />
                    <Field label="Industry" value={f.industry} />
                    <Field label="Company stage" value={f.company_stage} />
                    <Field label="Work mode" value={f.work_mode} />
                    <Field label="Remote region" value={f.remote_region} />
                    <Field label="Employment" value={f.employment_type} />
                    <Field label="Location" value={f.location ?? ([f.city, f.country].filter(Boolean).join(', ') || null)} />
                    <Field label="Salary" value={formatSalary(f)} />
                    <Field label="Visa sponsorship" value={f.visa_sponsorship} />
                    <Field label="Years required" value={f.required_years} />
                    <Field label="Languages" value={f.required_languages} />
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-1.5">
                    <Field label="Must-have skills" value={f.must_have_skills} />
                    <Field label="Nice-to-have" value={f.nice_to_have_skills} />
                    <Field label="Tech stack" value={f.tech_stack} />
                    <Field label="Problem domains" value={f.problem_domains} />
                    <Field label="Responsibilities" value={f.responsibilities} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
