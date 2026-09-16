import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

type Job = { id: string; state: string; message?: string; rollback_available?: boolean };
type Release = { update_available: boolean; available_version?: string; installed_version: string };
const terminal = new Set(["COMPLETED", "FAILED", "ROLLED_BACK", "ROLLBACK_FAILED"]);

export function LocalAgentActions({ kind, enabled, discoveryEnabled = enabled, autoDiscover = false, onComplete }: { readonly onComplete?: () => Promise<void>; readonly kind: "saturn" | "updater" | "gryphon"; readonly enabled: boolean; readonly discoveryEnabled?: boolean; readonly autoDiscover?: boolean }) {
  const key = `exocortex.${kind}.job`;
  const autoDiscoveryStarted = useRef(false);
  const [job, setJob] = useState<Job | undefined>(() => {
    const id = localStorage.getItem(key); return id && /^[A-Za-z0-9-]{1,128}$/.test(id) ? { id, state: "REQUESTED" } : undefined;
  });
  const [release, setRelease] = useState<Release>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = pending || (job !== undefined && !terminal.has(job.state));
  const check = useCallback(async () => {
    setPending(true); setError("");
    try { setRelease(await api.checkSaturnUpdate()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Discovery failed"); }
    finally { setPending(false); }
  }, []);
  useEffect(() => {
    if (!job || terminal.has(job.state)) return;
    let stopped = false;
    const timer = setInterval(() => { void api.agentJob(job.id).then(value => {
      if (stopped) return;
      setJob(value);
      if (terminal.has(value.state)) {
        localStorage.removeItem(key);
        if (value.state === "COMPLETED") {
          setError("");
          if (kind === "saturn") setRelease(undefined);
          void onComplete?.();
        }
      }
    }).catch(() => { /* The head can restart while the host finishes the job. */ }); }, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [job, key, kind, onComplete]);
  useEffect(() => {
    const resume = () => { const id = localStorage.getItem(key); if (id && /^[A-Za-z0-9-]{1,128}$/.test(id)) setJob({ id, state: "REQUESTED" }); };
    window.addEventListener("exocortex-agent-job", resume); window.addEventListener("storage", resume);
    return () => { window.removeEventListener("exocortex-agent-job", resume); window.removeEventListener("storage", resume); };
  }, [key]);
  async function run(action: () => Promise<Job>) {
    setPending(true); setError("");
    try { const value = await action(); localStorage.setItem(key, value.id); setJob(value); window.dispatchEvent(new Event("exocortex-agent-job")); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Operation failed"); }
    finally { setPending(false); }
  }
  useEffect(() => {
    if (kind !== "saturn" || !autoDiscover || !discoveryEnabled || job !== undefined || autoDiscoveryStarted.current) return;
    autoDiscoveryStarted.current = true;
    void check();
  }, [autoDiscover, check, discoveryEnabled, job, kind]);
  return <div className="local-agent-actions">
    {kind === "saturn" ? <>{autoDiscover ? pending ? <p role="status">Checking signed releases…</p> : null : <button className="button" disabled={!discoveryEnabled || busy} onClick={() => void check()}>{pending ? "Checking signed releases…" : "Check for updates"}</button>}
      {release ? <p>{release.update_available ? `Available: ${release.available_version ?? "unknown"}` : "Saturn is up to date."}</p> : null}
      {release?.update_available && release.available_version ? <button className="button button--primary" disabled={!enabled || busy} onClick={() => void run(() => api.installSaturnUpdate(release.available_version ?? ""))}>Back up and install Saturn {release.available_version}</button> : null}
      {job?.state === "COMPLETED" && job.rollback_available ? <button className="button" disabled={busy} onClick={() => void run(() => api.rollbackSaturnUpdate(job.id))}>Restore previous Saturn version and snapshot</button> : null}</> : null}
    {kind === "updater" ? <button className="button" disabled={!enabled || busy} onClick={() => void run(api.installUpdater)}>Install latest signed Updater</button> : null}
    {kind === "gryphon" ? <button className="button" disabled={!enabled || busy} onClick={() => void run(api.initializeGryphon)}>Install or connect Gryphon</button> : null}
    {job ? <p role="status">{job.state}{job.message ? ` · ${job.message}` : ""}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
