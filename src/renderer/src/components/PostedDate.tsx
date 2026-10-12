/** Posted-date display shared by the Jobs and Results screens (§3.4). */

/** Date used for "posted" sorting and display: the posting date when known, else first seen. */
export function jobDate(j: { postedAt: string | null; firstSeenAt: string }): string {
  return j.postedAt ?? j.firstSeenAt;
}

/** Posted-date cell: "estimated" whenever the date isn't a reliable source date. */
export default function PostedDate({ job }: { job: { postedAt: string | null; postedAtSource: string; firstSeenAt: string } }) {
  const d = new Date(jobDate(job));
  const estimated = job.postedAtSource !== 'source';
  const why: Record<string, string> = {
    source_republish: 'Last (re)published date from the ATS — a repost resets it',
    relative: 'Approximate — the source only says "N days ago"',
    first_seen: 'No posting date available — this is when the app first saw it',
    source: 'Posting date from the source',
  };
  return (
    <span title={`${why[job.postedAtSource] ?? ''}
First seen ${new Date(job.firstSeenAt).toLocaleString()}`}>
      {d.toLocaleDateString()}
      {estimated && <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-700">est.</span>}
    </span>
  );
}
