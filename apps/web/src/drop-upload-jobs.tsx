import { useState } from "react";
import type { DropUploadStatus } from "./types.js";

export interface DropUploadJob {
  readonly id: string;
  readonly name: string;
  readonly progress: number;
  readonly state: DropUploadStatus["state"] | "creating" | "unknown";
}

/** Keep every individual receipt, but bound DOM work during large selections. */
export function DropUploadJobs({ jobs, label, canRemove, cancelling, onRemove }: {
  readonly jobs: readonly DropUploadJob[];
  readonly label: string;
  readonly canRemove: (job: DropUploadJob) => boolean;
  readonly cancelling: ReadonlySet<string>;
  readonly onRemove: (id: string) => void;
}) {
  const [requestedPage, setPage] = useState(0);
  const pageSize = 100;
  const pageCount = Math.max(1, Math.ceil(jobs.length / pageSize));
  const page = Math.min(requestedPage, pageCount - 1);
  const stored = jobs.filter(job => job.state === "stored").length;
  const buffered = jobs.filter(job => ["buffered", "transferring", "verifying"].includes(job.state)).length;
  if (jobs.length === 0) return null;
  return <div className="drop-jobs" role="region" aria-label={label} data-total={jobs.length} data-stored={stored} data-buffered={buffered}>
    <p role="status">{stored} of {jobs.length} stored · {buffered} waiting for storage</p>
    {jobs.slice(page * pageSize, (page + 1) * pageSize).map(job => <div className={`drop-job ${job.state === "stored" ? "drop-job--stored" : ""}`} key={job.id}>
      <span>{job.name}</span><progress max={1} value={job.progress} /><strong>{job.state}</strong>
      {canRemove(job) ? <button type="button" onClick={() => onRemove(job.id)} disabled={cancelling.has(job.id)}>Remove</button> : null}
    </div>)}
    {pageCount <= 1 ? null : <nav aria-label="Upload result pages">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous uploads</button>
      <span>Page {page + 1} of {pageCount}</span>
      <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>Next uploads</button>
    </nav>}
  </div>;
}
