import { describe, expect, it } from 'vitest';
import { computeTotal, computeVerdict, DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from '@shared/scoring';

const subs = { skills: 80, domain_fit: 60, project_similarity: 70, experience_fit: 90, preferences_fit: 50 };

describe('computeTotal', () => {
  it('matches Σ(score × weight) / 100 with default weights', () => {
    // 80*25 + 60*25 + 70*25 + 90*15 + 50*10 = 2000+1500+1750+1350+500 = 7100 → 71
    expect(computeTotal(subs, DEFAULT_WEIGHTS)).toBe(71);
  });

  it('rounds to the nearest integer', () => {
    const w = { skills: 1, domain_fit: 1, project_similarity: 1, experience_fit: 0, preferences_fit: 0 };
    expect(computeTotal({ ...subs, skills: 81 }, w)).toBe(70); // (81+60+70)/3 = 70.33
  });

  it('normalises when weights do not sum to 100', () => {
    const doubled = Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => [k, v * 2])) as typeof DEFAULT_WEIGHTS;
    expect(computeTotal(subs, doubled)).toBe(71);
  });

  it('changing weights changes the total without new data', () => {
    const skillsHeavy = { skills: 100, domain_fit: 0, project_similarity: 0, experience_fit: 0, preferences_fit: 0 };
    expect(computeTotal(subs, skillsHeavy)).toBe(80);
  });

  it('returns 0 when all weights are 0', () => {
    const zero = { skills: 0, domain_fit: 0, project_similarity: 0, experience_fit: 0, preferences_fit: 0 };
    expect(computeTotal(subs, zero)).toBe(0);
  });
});

describe('computeVerdict', () => {
  it.each([
    [100, 'strong'],
    [80, 'strong'],
    [79, 'good'],
    [65, 'good'],
    [64, 'stretch'],
    [50, 'stretch'],
    [49, 'skip'],
    [0, 'skip'],
  ])('%i → %s', (total, verdict) => {
    expect(computeVerdict(total, DEFAULT_THRESHOLDS)).toBe(verdict);
  });
});
