import type { ModelRow } from '@shared/types';
import type { RawUsage } from './types';

/** Anthropic bills 5-minute cache writes at 1.25× the base input price. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

export function computeCost(
  usage: RawUsage,
  prices: Pick<ModelRow, 'price_in' | 'price_out' | 'price_cache_read'>,
): number {
  const usd =
    usage.uncachedInput * prices.price_in +
    usage.cacheWrite * prices.price_in * CACHE_WRITE_MULTIPLIER +
    usage.cachedInput * prices.price_cache_read +
    usage.output * prices.price_out;
  return usd / 1_000_000;
}
