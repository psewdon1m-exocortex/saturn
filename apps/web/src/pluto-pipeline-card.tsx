import type { DeviceInfo } from "./types.js";

export function PlutoPipelineCard({ device, pending, onSetup, onRevoke }: { readonly device: DeviceInfo; readonly pending: boolean; readonly onSetup: () => void; readonly onRevoke: () => void }) {
  const status = device.plutoStatus;
  const online = device.lastSeenAt !== undefined && Date.now() - new Date(device.lastSeenAt).getTime() < 60_000;
  return <article className="pipeline-connection-card pipeline-connection-card--windows" aria-label={device.name}>
    <div className="pipeline-identity"><span className="pipeline-identity__label">Connection name</span><strong>{device.name}</strong><span className="pipeline-identity__type">Pluto · Linux files and folders</span><span>backups/pluto/{device.syncFolderName ?? device.name}</span><span>{online ? "online" : "waiting for check-in"} · Pluto {device.clientVersion ?? "unknown"}</span><span>{status?.enabled ? "Copying enabled" : "Copying disabled"}{status ? ` · every ${String(status.intervalSeconds)} seconds · ${String(status.uploadedFiles)} files uploaded in last run` : ""}</span><span>{status?.lastSuccessAt ? `Last successful copy: ${new Date(status.lastSuccessAt).toLocaleString()}` : "No successful copy reported"}{status?.nextRunAt ? ` · next ${new Date(status.nextRunAt).toLocaleString()}` : ""}</span>{status?.error ? <span className="danger-text">{status.error}</span> : null}<span>Sources and schedule are managed in Pluto TUI. Up to 10 versions per file.</span></div>
    <div className="inline-actions"><button className="button" type="button" disabled={pending} onClick={onSetup}>Setup code</button><button className="button button--danger" type="button" disabled={pending} onClick={onRevoke}>Revoke</button></div>
  </article>;
}
