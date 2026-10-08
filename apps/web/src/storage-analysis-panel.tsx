import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api.js";
import type { StorageAnalysisJob, StorageAnalysisReport } from "./types.js";

const ACTIVE = new Set(["queued", "analyzing", "sync_queued", "syncing"]);
const STATES: Record<StorageAnalysisJob["state"], string> = {
  queued: "Analysis queued", analyzing: "Analyzing storage", ready: "Analysis complete",
  sync_queued: "Synchronization queued", syncing: "Verifying and synchronizing",
  synchronized: "Catalog synchronized", stale: "Report is out of date", failed: "Analysis failed",
};
const REASONS: Record<string, string> = {
  not_in_catalog: "Not yet in the catalog", content_changed: "File content changed",
  folder_size_changed: "Folder total changed", resource_can_be_recovered: "File or folder can be made visible again",
  not_on_storage: "Absent from the connected storage", protected_root_missing: "Protected root folder is absent",
  catalog_state_or_type_conflict: "Conflicts with a pending, trashed or differently typed resource",
  immutable_resource_changed: "An immutable resource changed", file_in_storage_root: "Move this file into a folder before importing",
  unsupported_or_conflicting_path: "Unsupported or conflicting name/path",
};
function failureMessage(code: string | null): string {
  if (code === "storage_analysis_stale") return "The storage or catalog changed after analysis. Analyze again before synchronizing.";
  if (code === "storage_analysis_unsupported_entry") return "The storage contains a symbolic link or unsupported entry. Resolve it and analyze again; the catalog was not changed.";
  if (code?.includes("limit")) return "The analysis reached its safety limit. No catalog changes were applied.";
  if (code === "storage_changed_during_analysis") return "A file changed while it was being read. Wait for uploads to finish and analyze again.";
  return "The storage could not be fully analyzed. No catalog changes were applied; retry when the connection is available.";
}

export function StorageAnalysisPanel({ profileId, profileRevision, disabled, addNotice }: {
  readonly profileId?: string | undefined; readonly profileRevision?: number | undefined; readonly disabled: boolean;
  readonly addNotice: (kind: "success" | "error", message: string) => void;
}) {
  const [report, setReport] = useState<StorageAnalysisReport | undefined>();
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const sequence = useRef(0);
  const reportId = useRef<string | undefined>(undefined);
  const load = useCallback(async (offset = 0) => {
    const request = ++sequence.current;
    try {
      const raw: unknown = await api.storageAnalysis(offset);
      if (request !== sequence.current) return;
      if (typeof raw !== "object" || raw === null || !("job" in raw)) { setReport(undefined); return; }
      const value = raw as StorageAnalysisReport;
      if (reportId.current !== value.job?.id) { setConfirmed(false); reportId.current = value.job?.id; }
      setReport(value); setError("");
    } catch { if (request === sequence.current) setError("The analysis report is unavailable. Refresh to retry."); }
  }, []);
  useEffect(() => {
    setReport(undefined); setConfirmed(false); reportId.current = undefined;
    void load();
    return () => { sequence.current += 1; };
  }, [load, profileId, profileRevision]);
  const job = report?.job;
  const active = job !== null && job !== undefined && ACTIVE.has(job.state);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void load(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const analyze = async () => {
    setPending(true); setConfirmed(false); setOpen(true); setError("");
    try {
      const created = await api.analyzeStorage();
      setReport({ job: created, items: [], offset: 0, hasMore: false });
      await load();
      addNotice("success", "Storage analysis started. You can leave this page and return to the saved report.");
    } catch (error) {
      setError(error instanceof ApiError && error.code === "storage_analysis_in_progress" ? "An analysis or synchronization is already running. Refresh its report." : "Storage analysis could not be started.");
    } finally { setPending(false); }
  };
  const synchronize = async () => {
    if (!confirmed || !job?.canSynchronize) return;
    setPending(true); setError("");
    try {
      const queued = await api.synchronizeStorageCatalog(job.id);
      setReport(previous => previous === undefined ? previous : { ...previous, job: queued });
      setConfirmed(false); await load();
      addNotice("success", "Catalog synchronization queued. The report will show the final result.");
    } catch { setError("This report can no longer be applied. Refresh it or analyze the storage again."); }
    finally { setPending(false); }
  };
  const changeCount = job === null || job === undefined ? 0 : Object.values(job.counts).reduce((sum, count) => sum + count, 0);
  return <section className="settings-group storage-analysis">
    <h3>Storage catalog</h3>
    <p>Analyze the active storage for files and changes missing from Saturn’s catalog. Analysis reads files without moving or deleting them.</p>
    <div className="storage-analysis__actions">
      <button className="button settings-action" type="button" disabled={disabled || pending || active} onClick={() => void analyze()}>{active ? "Storage task in progress…" : "Analyze storage"}</button>
      <button className="button settings-action" type="button" disabled={pending} onClick={() => void load(report?.offset ?? 0)}>Refresh report</button>
    </div>
    {error === "" ? null : <p className="danger-text" role="alert">{error}</p>}
    {report === undefined || job === null || job === undefined ? null : <div className="storage-analysis__result">
      <p role="status" aria-live="polite">{STATES[job.state]} · {job.scannedEntries.toLocaleString()} entries · {(job.scannedBytes / (1024 * 1024)).toFixed(1)} MiB read</p>
      {active ? <><progress aria-label="Storage analysis progress" /><p className="setting-meta">{job.currentPath ?? "Waiting for the worker…"} · The task continues when this page is closed.</p></> : null}
      <p className="setting-meta">{new Date(job.completedAt ?? job.createdAt).toLocaleString()} · Profile revision {job.profileRevision}</p>
      {job.state === "failed" || job.state === "stale" ? <p className="danger-text" role="alert">{failureMessage(job.failureCode)}</p> : null}
      {job.state === "ready" && changeCount === 0 ? <p>No differences found. The catalog matches the visible storage tree.</p> : null}
      {job.state === "synchronized" ? <p>Catalog changes were applied. File bytes were preserved.</p> : null}
      {changeCount === 0 ? null : <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>Analysis report · {job.counts.added} new · {job.counts.changed} changed · {job.counts.missing} absent · {job.counts.blocked} blocked</summary>
        <div className="storage-analysis__table" tabIndex={0} aria-label="Storage differences">
          <table><thead><tr><th>Change</th><th>Path</th><th>Finding</th></tr></thead>
            <tbody>{report.items.map(item => <tr key={`${item.kind}:${item.storagePath}`}><td>{item.kind}</td><td>{item.storagePath || "/"}</td><td>{REASONS[item.reason] ?? item.reason}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="storage-analysis__pagination"><button className="button" type="button" disabled={pending || report.offset === 0} onClick={() => void load(Math.max(0, report.offset - 100))}>Previous</button><span>{report.offset + 1}–{report.offset + report.items.length} of {changeCount}</span><button className="button" type="button" disabled={pending || !report.hasMore} onClick={() => void load(report.offset + 100)}>Next</button></div>
      </details>}
      {job.state === "ready" && job.counts.blocked > 0 ? <p className="danger-text">Resolve the blocked entries and analyze again before synchronizing.</p> : null}
      {!job.canSynchronize ? null : <div className="storage-analysis__confirmation">
        <p>Synchronization imports new files, updates changed metadata and marks absent files as missing. Affected shared links are revoked. Old bytes overwritten outside Saturn cannot be recovered by this operation.</p>
        <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Apply the reported changes to the catalog</label>
        <button className="button button--primary settings-action" type="button" disabled={pending || disabled || !confirmed} onClick={() => void synchronize()}>Synchronize catalog</button>
      </div>}
    </div>}
  </section>;
}
