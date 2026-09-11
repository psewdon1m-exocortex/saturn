import { useState, type SubmitEvent } from "react";
import { api } from "./api.js";

export function HelperRecoveryPanel({ enabled }: { readonly enabled: boolean }) {
  const [key, setKey] = useState("");
  const [file, setFile] = useState<File>();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function exportArchive(event: SubmitEvent) {
    event.preventDefault(); setPending(true); setMessage("");
    try { const blob = await api.exportHelpers(key); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `exocortex-helpers-${new Date().toISOString().replaceAll(":", "-")}.exorecovery`; link.click(); URL.revokeObjectURL(url); setKey(""); setMessage("Encrypted helper archive downloaded."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Export failed"); }
    finally { setPending(false); }
  }
  async function restore() {
    if (!file || file.size > 130 * 1024 * 1024) { setMessage("Select a helper archive no larger than 130 MB."); return; }
    setPending(true); setMessage("");
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("Cannot read archive")); reader.onload = () => { if (typeof reader.result !== "string") reject(new Error("Invalid archive")); else resolve(reader.result.split(",")[1] ?? ""); }; reader.readAsDataURL(file); });
      const job = await api.restoreHelpers(key, data, confirmation); setKey(""); setConfirmation(""); localStorage.setItem("exocortex.saturn.job", job.id); window.dispatchEvent(new Event("exocortex-agent-job"));
      setMessage(`Recovery accepted: ${job.id}. Its final result is tracked in Updates.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Recovery failed"); }
    finally { setPending(false); }
  }
  return <section className="settings-group"><h3>Helper recovery</h3><p>Encrypted state of Updater, Neptune and Gryphon includes local credentials and bindings. Keep the recovery passphrase separately. Install trusted binaries and provision external trust keys before restoring on a new host.</p>
    <form onSubmit={event => void exportArchive(event)}><label>Recovery passphrase<input type="password" autoComplete="off" minLength={16} maxLength={1024} value={key} onChange={event => setKey(event.target.value)} required /></label><button className="button" disabled={!enabled || pending}>Download encrypted helper state</button></form>
    <label>Helper archive<input type="file" accept=".exorecovery" disabled={pending} onChange={event => setFile(event.target.files?.[0])} /></label>
    <label>Type RESTORE HELPERS to replace helper state<input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
    <button className="button button--danger" disabled={!enabled || pending || key.length < 16 || !file || confirmation !== "RESTORE HELPERS"} onClick={() => void restore()}>Restore helper state</button>
    {message ? <p role="status">{message}</p> : null}</section>;
}
