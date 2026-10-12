import { z } from 'zod';

export const SUB_SCORE_KEYS = ['skills', 'domain_fit', 'project_similarity', 'experience_fit', 'preferences_fit'] as const;
export type SubScoreKey = (typeof SUB_SCORE_KEYS)[number];

export const SUB_SCORE_LABELS: Record<SubScoreKey, string> = {
  skills: 'Skills',
  domain_fit: 'Domain fit',
  project_similarity: 'Project similarity',
  experience_fit: 'Experience fit',
  preferences_fit: 'Preferences fit',
};

export const WeightsSchema = z.object({
  skills: z.number().min(0),
  domain_fit: z.number().min(0),
  project_similarity: z.number().min(0),
  experience_fit: z.number().min(0),
  preferences_fit: z.number().min(0),
});
export type Weights = z.infer<typeof WeightsSchema>;

export const DEFAULT_WEIGHTS: Weights = {
  skills: 25,
  domain_fit: 25,
  project_similarity: 25,
  experience_fit: 15,
  preferences_fit: 10,
};

export const ThresholdsSchema = z.object({
  strong: z.number(),
  good: z.number(),
  stretch: z.number(),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const DEFAULT_THRESHOLDS: Thresholds = { strong: 80, good: 65, stretch: 50 };

export type Verdict = 'strong' | 'good' | 'stretch' | 'skip';

export const VERDICT_LABELS: Record<Verdict, string> = {
  strong: 'Strong',
  good: 'Good',
  stretch: 'Stretch',
  skip: 'Skip',
};

/**
 * Weighted total, computed in code (never trust LLM arithmetic).
 * total = Σ(sub_score × weight) / Σ(weight). With the default weights (sum 100) this is exactly
 * Σ(sub_score × weight) / 100; normalising by the sum keeps totals on a 0–100 scale if edited
 * weights don't add up to 100.
 */
export function computeTotal(subScores: Record<SubScoreKey, number>, weights: Weights): number {
  let sum = 0;
  let wsum = 0;
  for (const k of SUB_SCORE_KEYS) {
    const w = weights[k];
    sum += (subScores[k] ?? 0) * w;
    wsum += w;
  }
  if (wsum <= 0) return 0;
  return Math.round(sum / wsum);
}

export function computeVerdict(total: number, t: Thresholds): Verdict {
  if (total >= t.strong) return 'strong';
  if (total >= t.good) return 'good';
  if (total >= t.stretch) return 'stretch';
  return 'skip';
}
