import { ATS_SOURCE_KEYS } from '@shared/sources';
import { appEvents } from '../events';
import { adapterFor } from '../sources';
import type { SourceContext } from '../sources/types';
import { applyFetchedJob, getJobItem } from '../repos/jobs';

const ATS_KEYS = new Set(ATS_SOURCE_KEYS);

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

/** Fetch clean data for pasted ATS links (Greenhouse/Lever/Ashby/Workday) via the adapter's fetchJob. */
export async function enrichAtsJobs(
  jobIds: number[],
  ctx: SourceContext,
): Promise<{ enriched: number; failed: { url: string; error: string }[] }> {
  let enriched = 0;
  const failed: { url: string; error: string }[] = [];
  await pool(jobIds, 3, async (id) => {
    const job = getJobItem(id);
    if (!job?.url || !ATS_KEYS.has(job.sourceKey)) return;
    const adapter = adapterFor(job.sourceKey);
    if (!adapter.fetchJob) return;
    try {
      const raw = await adapter.fetchJob(job.url, ctx);
      applyFetchedJob(id, raw, job.sourceKey);
      enriched++;
    } catch (e) {
      if (ctx.signal?.aborted) return;
      failed.push({ url: job.url, error: (e as Error).message });
    }
  });
  if (enriched) appEvents.emit('jobs:updated', { count: enriched });
  return { enriched, failed };
}
