import { useEffect, useRef, useState } from "react";
import { api, dropApi, resumeOwnerUpload, uploadDropFile } from "./api.js";
import { listUploadRecovery, type UploadRecoveryRecord } from "./upload-recovery-store.js";
import { hydrateUploadRecovery } from "./upload-recovery-durable.js";
import "./upload-recovery.css";

export function DropRecoveryAccessHint({ channelId }: { readonly channelId?: string | undefined }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      try { if (active) setCount(listUploadRecovery().filter(record => record.channel === "drop" && record.channelId !== channelId).length); }
      catch { /* Storage errors are reported by App and admission fails closed. */ }
    };
    refresh(); void hydrateUploadRecovery().then(refresh).catch(() => undefined);
    window.addEventListener("saturn-upload-recovery", refresh); window.addEventListener("storage", refresh);
    return () => { active = false; window.removeEventListener("saturn-upload-recovery", refresh); window.removeEventListener("storage", refresh); };
  }, [channelId]);
  if (count === 0) return null;
  return <p className="drop-recovery-access" role="status">{count} pending upload(s) {channelId === undefined ? "remain saved in this browser" : "belong to another Drop channel"}. To recover them, enter the original Drop code while it is valid. A different code opens a different channel; it does not resume these uploads.</p>;
}

/** Reselection is explicit: local metadata cannot retain a usable File handle
 * across browser closure. A full source hash is checked before resuming. */
export function UploadRecoveryPanel({ channel, scopeId, disabled = false, onRecovered, onBusy }: {
  readonly channel: "owner" | "drop"; readonly scopeId: string; readonly disabled?: boolean; readonly onRecovered?: () => void; readonly onBusy?: (busy: boolean) => void;
}) {
  const [records, setRecords] = useState<readonly UploadRecoveryRecord[]>([]);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [page, setPage] = useState(0);
  const selection = useRef<UploadRecoveryRecord | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    let current = true;
    const refresh = () => {
      try { setRecords(listUploadRecovery().filter(record => record.channel === channel && (record.channel === "owner" ? record.parentId : record.channelId) === scopeId)); }
      catch (error) { setMessage(error instanceof Error ? error.message : "Upload recovery metadata is unavailable."); }
    };
    refresh(); setPage(0);
    void hydrateUploadRecovery().then(() => { if (current) refresh(); }).catch((error: unknown) => {
      if (current) setMessage(error instanceof Error ? error.message : "Upload recovery metadata is unavailable.");
    });
    window.addEventListener("saturn-upload-recovery", refresh); window.addEventListener("storage", refresh);
    return () => { current = false; window.removeEventListener("saturn-upload-recovery", refresh); window.removeEventListener("storage", refresh); controller.current?.abort(); };
  }, [channel, scopeId]);
  const recover = async (file: File | undefined) => {
    const record = selection.current; selection.current = undefined;
    if (record === undefined || file === undefined || pending) return;
    setPending(true); onBusy?.(true); setMessage("Verifying the complete selected file before continuing…");
    const abort = new AbortController(); controller.current = abort;
    try {
      if (file.name !== record.filename || file.size !== record.expectedSize || file.lastModified !== record.lastModified) throw new Error(`Select the original ${record.filename} without modifications.`);
      if (record.channel === "owner") {
        await resumeOwnerUpload(record.id ?? record.operationId, file, () => undefined, async () => {
          if (record.id === undefined) return;
          const response = await fetch(`/api/v1/uploads/${encodeURIComponent(record.id)}`, { method: "HEAD", credentials: "same-origin", signal: abort.signal });
          if (!response.ok) throw new Error("The original upload status could not be verified.");
          if (response.headers.get("Upload-Status") === "paused") await api.controlTransferTask(record.id, "resume");
        }, { signal: abort.signal });
        setMessage("Original upload completed.");
      } else {
        const result = await uploadDropFile(file, () => undefined, { channelId: record.channelId, signal: abort.signal });
        setMessage(result.state === "stored" || result.state === "completed" ? "Original upload is stored." : "Original upload is buffered; storage completion is still pending.");
      }
      onRecovered?.();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The original upload could not be resumed."); }
    finally { controller.current = undefined; setPending(false); onBusy?.(false); if (input.current !== null) input.current.value = ""; }
  };
  const check = async (record: UploadRecoveryRecord) => {
    if (record.channel !== "drop" || record.id === undefined || pending) return;
    setPending(true); onBusy?.(true);
    try { const result = await dropApi.status(record.id, AbortSignal.timeout(5_000), record.channelId); setMessage(`Original upload: ${result.state}.`); onRecovered?.(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Original status is unknown; no replacement upload was created."); }
    finally { setPending(false); onBusy?.(false); }
  };
  if (records.length === 0 && !message) return null;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(records.length / 8) - 1));
  return <section className="upload-recovery" aria-label="Upload recovery"><details open><summary>Upload recovery · {records.length} pending</summary>
    {records.length === 0 ? null : <><p>{records.length} upload(s) awaiting a confirmed result. Reselect the original file to verify its full SHA-256 and continue. Browser closure requires reselection.</p>
      <ul>{records.slice(currentPage * 8, currentPage * 8 + 8).map(record => <li key={record.operationId}><span>{record.filename} · {record.expectedSize} bytes</span>{" "}
        <button type="button" disabled={disabled || pending} onClick={() => { selection.current = record; input.current?.click(); }}>Reselect original file</button>{" "}
        {record.channel === "drop" && record.id !== undefined ? <button type="button" disabled={disabled || pending} onClick={() => void check(record)}>Check stored status</button> : null}
      </li>)}</ul>
      {records.length <= 8 ? null : <nav aria-label="Upload recovery pages"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage + 1} / {Math.ceil(records.length / 8)}</span><button type="button" disabled={(currentPage + 1) * 8 >= records.length} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}
    </>}
    <input ref={input} type="file" className="visually-hidden-input" aria-label="Reselect original upload source" onChange={event => void recover(event.target.files?.[0])} />
    {pending ? <button type="button" onClick={() => controller.current?.abort()}>Stop recovery</button> : null}
    {message ? <p role="status">{message}</p> : null}
  </details></section>;
}
