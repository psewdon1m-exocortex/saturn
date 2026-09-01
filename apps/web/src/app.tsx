import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type SyntheticEvent } from "react";
import type { HealthResponse } from "@saturn/contracts";
import { ApiError, api, downloadUrl, dropApi, publicShareApi, uploadDropFile, uploadFile } from "./api.js";
import {
  BACKUPS_RESOURCE_ID,
  DROP_POINT_RESOURCE_ID,
  LABORATORY_RESOURCE_ID,
  MASTERMIND_RESOURCE_ID,
  VOLT_RESOURCE_ID,
  ROOT_RESOURCE_ID,
  SYNC_RESOURCE_ID,
  type AuditEvent,
  type BackupServiceInfo,
  type DeviceInfo,
  type FileVersion,
  type LaboratoryAssetInfo,
  type LaboratoryClientInfo,
  type OwnerPreferences,
  type Resource,
  type ShareChild,
  type ShareInfo,
  type DropSessionInfo,
  type TelegramStatus,
} from "./types.js";

type GatewayState = "checking" | "ready" | "degraded";
type ViewName = "files" | "laboratory" | "inbox" | "shared" | "activity" | "settings" | "trash";
type Notice = { readonly id: string; readonly kind: "success" | "error" | "info"; readonly message: string };

const PROTECTED_ROOT_RESOURCE_IDS = new Set([
  DROP_POINT_RESOURCE_ID,
  LABORATORY_RESOURCE_ID,
  BACKUPS_RESOURCE_ID,
  MASTERMIND_RESOURCE_ID,
  SYNC_RESOURCE_ID,
  VOLT_RESOURCE_ID,
]);

const defaultPreferences: Omit<OwnerPreferences, "updatedAt"> = {
  darkColor: "#000000",
  lightColor: "#ffffff",
  accentColor: "#00a8ff",
};

function appearancePreferences(value: OwnerPreferences | Omit<OwnerPreferences, "updatedAt">): Omit<OwnerPreferences, "updatedAt"> {
  return { darkColor: value.darkColor, lightColor: value.lightColor, accentColor: value.accentColor };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KiB";
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function useGatewayHealth(): GatewayState {
  const [state, setState] = useState<GatewayState>("checking");
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch("/health/ready", { credentials: "same-origin", cache: "no-store" });
        const body = await response.json() as HealthResponse;
        if (active) setState(response.ok && body.status === "ok" ? "ready" : "degraded");
      } catch {
        if (active) setState("degraded");
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return state;
}

function HealthLabel({ state }: { readonly state: GatewayState }) {
  return (
    <span className={`health health--${state}`} role="status" aria-live="polite">
      <span className="health__dot" aria-hidden="true" />
      {state === "checking" ? "Checking" : state === "ready" ? "Available" : "Unavailable"}
    </span>
  );
}

function LoginView({ health, onAuthenticated }: { readonly health: GatewayState; readonly onAuthenticated: () => void }) {
  const [accessKey, setAccessKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessKey || pending) return;
    setPending(true);
    setError("");
    try {
      await api.login(accessKey);
      setAccessKey("");
      onAuthenticated();
    } catch (caught) {
      setAccessKey("");
      setError(caught instanceof ApiError && caught.status === 429
        ? "Too many attempts. Wait before trying again."
        : "The access key was not accepted.");
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="login-view">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-panel__head">
          <h1 id="login-title" className="wordmark" aria-label="Saturn">SATURN</h1>
          <HealthLabel state={health} />
        </div>
        <p className="login-copy">Private storage gateway. Authenticate to enter the owner workspace.</p>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="owner-access-key">Owner access key</label>
          <input
            id="owner-access-key"
            name="owner-access-key"
            type="password"
            autoComplete="current-password"
            value={accessKey}
            onChange={(event) => setAccessKey(event.target.value)}
            disabled={pending}
            required
            autoFocus
          />
          <button className="button button--primary" type="submit" disabled={pending || !accessKey}>
            {pending ? "Authenticating…" : "Enter Saturn"}
          </button>
          <p className="form-error" role="alert">{error}</p>
        </form>
      </section>
    </main>
  );
}

function Dialog({ title, description, children, onClose }: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header className="dialog__head">
          <h2 id="dialog-title">{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">×</button>
        </header>
        {description === undefined ? null : <p className="muted">{description}</p>}
        {children}
      </section>
    </div>
  );
}

function ConfirmDialog({ title, description, confirmLabel, danger = false, pending, onConfirm, onClose }: {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog title={title} description={description} onClose={onClose}>
      <div className="dialog__actions">
        <button className="button" type="button" onClick={onClose} disabled={pending}>Cancel</button>
        <button className={`button ${danger ? "button--danger" : "button--primary"}`} type="button" onClick={onConfirm} disabled={pending}>
          {pending ? "Working…" : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

function DropView({ health }: { readonly health: GatewayState }) {
  const [state, setState] = useState<"checking" | "redeem" | "active">("checking");
  const [session, setSession] = useState<DropSessionInfo | undefined>();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [jobs, setJobs] = useState<Array<{ readonly id: string; readonly name: string; readonly progress: number; readonly state: "uploading" | "completed" | "failed" }>>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void dropApi.session().then((value) => { setSession(value); setState("active"); }).catch(() => setState("redeem"));
  }, []);

  const redeem = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!code || pending) return; setPending(true); setMessage("");
    try { const value = await dropApi.redeem(code); setCode(""); setSession(value); setState("active"); }
    catch (error) { setCode(""); setMessage(error instanceof ApiError && error.status === 429 ? "Too many attempts. Wait before trying again." : "The Drop code was not accepted."); }
    finally { setPending(false); }
  };

  const upload = async (files: readonly File[]) => {
    if (files.length === 0 || pending) return;
    setPending(true); setMessage("");
    for (const file of files) {
      const id = crypto.randomUUID();
      setJobs((current) => [...current, { id, name: file.name, progress: 0, state: "uploading" }]);
      try {
        await uploadDropFile(file, (progress) => setJobs((current) => current.map((job) => job.id === id ? { ...job, progress } : job)));
        setJobs((current) => current.map((job) => job.id === id ? { ...job, progress: 1, state: "completed" } : job));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) { setState("redeem"); setSession(undefined); }
        setJobs((current) => current.map((job) => job.id === id ? { ...job, state: "failed" } : job));
        setMessage("An upload stopped before commit. No partial file is visible in Drop Point.");
      }
    }
    setPending(false); if (input.current !== null) input.current.value = "";
  };

  const logout = async () => {
    setPending(true);
    try { await dropApi.logout(); } finally { setSession(undefined); setState("redeem"); setJobs([]); setPending(false); }
  };

  if (state === "checking") return <main className="boot-state">Checking Drop session…</main>;
  return (
    <main className="drop-view" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (state === "active") void upload([...event.dataTransfer.files]); }}>
      <section className="drop-panel" aria-labelledby="drop-title">
        <header className="drop-panel__head"><div><p className="eyebrow">Upload-only gateway</p><h1 id="drop-title" className="wordmark wordmark--drop">Saturn Drop</h1></div><HealthLabel state={health} /></header>
        {state === "redeem" ? (
          <form className="drop-redeem" onSubmit={(event) => void redeem(event)}>
            <p className="muted">Enter the one-time code from the bound Telegram bot. Codes never belong in a URL.</p>
            <label>Drop code<input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} autoComplete="one-time-code" inputMode="text" maxLength={9} required autoFocus /></label>
            <button className="button button--primary" type="submit" disabled={pending || !code}>{pending ? "Redeeming…" : "Open upload session"}</button>
            <p className="form-error" role="alert">{message}</p>
          </form>
        ) : (
          <div className="drop-active">
            <div className="drop-policy"><strong>UPLOAD ONLY</strong><span>No listing · no reading · no overwrite · no delete</span><span>Expires {session === undefined ? "soon" : new Date(session.expiresAt).toLocaleTimeString()}</span></div>
            <button className="drop-target" type="button" disabled={pending} onClick={() => input.current?.click()}>
              <span>Drop files here</span><small>or choose files · up to {String(session?.maxFiles ?? 20)} files / {formatBytes(session?.maxBytes ?? 0)}</small>
            </button>
            <input ref={input} aria-label="Choose files for Drop" className="visually-hidden-input" type="file" multiple onChange={(event) => void upload([...event.target.files ?? []])} />
            <div className="drop-jobs" role="region" aria-live="polite" aria-label="This session upload queue">
              {jobs.length === 0 ? <p className="empty-state">This page cannot list Saturn contents. Only files selected in this browser session appear here.</p> : jobs.map((job) => <div className="drop-job" key={job.id}><span>{job.name}</span><progress max={1} value={job.progress} /><strong>{job.state}</strong></div>)}
            </div>
            <p className="form-error" role="alert">{message}</p>
            <div className="inline-actions"><button className="button" type="button" onClick={() => void logout()} disabled={pending}>End Drop session</button></div>
          </div>
        )}
      </section>
    </main>
  );
}

function NoticeStack({ notices, dismiss }: { readonly notices: readonly Notice[]; readonly dismiss: (id: string) => void }) {
  return (
    <div className="notice-stack" role="region" aria-live="polite" aria-label="Notifications">
      {notices.slice(-5).map((notice) => (
        <div className={`notice notice--${notice.kind}`} key={notice.id}>
          <span>{notice.message}</span>
          <button type="button" onClick={() => dismiss(notice.id)} aria-label="Dismiss notification">×</button>
        </div>
      ))}
    </div>
  );
}

function CollectionToolbar({ search, setSearch, count, children }: {
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly count: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="collection-toolbar" role="search" aria-label="Collection controls">
      <label className="search-control">
        <span className="sr-only">Search collection</span>
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" />
      </label>
      <output className="collection-count" aria-live="polite">{count}</output>
      <div className="collection-actions">{children}</div>
    </div>
  );
}

function FilesView({ initialFolderId, title, addNotice, onUnauthorized }: {
  readonly initialFolderId: string;
  readonly title: string;
  readonly addNotice: (kind: Notice["kind"], message: string) => void;
  readonly onUnauthorized: () => void;
}) {
  const [folderId, setFolderId] = useState(initialFolderId);
  const [folder, setFolder] = useState<Resource | undefined>();
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ readonly id: string; readonly name: string }>>([]);
  const [items, setItems] = useState<readonly Resource[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | undefined>();
  const [form, setForm] = useState<"folder" | "rename" | "move" | "copy" | undefined>();
  const [formName, setFormName] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [versions, setVersions] = useState<{ readonly resource: Resource; readonly items: readonly FileVersion[] } | undefined>();
  const [restoreVersion, setRestoreVersion] = useState<FileVersion | undefined>();
  const [preview, setPreview] = useState<Resource | undefined>();
  const [laboratoryFragment, setLaboratoryFragment] = useState<string | undefined>();
  const uploadInput = useRef<HTMLInputElement>(null);
  const overwriteInput = useRef<HTMLInputElement>(null);

  const handleError = (error: unknown, message = "The operation could not be completed.") => {
    if (error instanceof ApiError && error.status === 401) onUnauthorized();
    else addNotice("error", message);
  };

  const reload = async () => {
    setLoading(true);
    try {
      const [resource, children] = await Promise.all([api.resource(folderId), api.children(folderId)]);
      setFolder(resource);
      setItems(children);
      setSelected(new Set());
    } catch (error) {
      handleError(error, "The folder could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setFolderId(initialFolderId);
    setBreadcrumbs([]);
  }, [initialFolderId]);
  useEffect(() => { void reload(); }, [folderId]);

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? items.filter((item) => item.name.toLocaleLowerCase().includes(query)) : items;
  }, [items, search]);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const single = selectedItems.length === 1 ? selectedItems[0] : undefined;
  const atStorageRoot = folderId === ROOT_RESOURCE_ID;
  const selectedProtectedRoot = selectedItems.some((item) => PROTECTED_ROOT_RESOURCE_IDS.has(item.id));
  const singleProtectedRoot = single !== undefined && PROTECTED_ROOT_RESOURCE_IDS.has(single.id);

  const openFolder = (resource: Resource) => {
    if (resource.type !== "folder") return;
    setBreadcrumbs((current) => [...current, { id: folderId, name: folder?.name ?? title }]);
    setFolderId(resource.id);
  };

  const navigateBreadcrumb = (index: number) => {
    const target = breadcrumbs[index];
    if (target === undefined) return;
    setFolderId(target.id);
    setBreadcrumbs((current) => current.slice(0, index));
  };

  const performUpload = async (files: readonly File[], overwrite?: Resource) => {
    if (files.length === 0 || pending) return;
    if (atStorageRoot) {
      addNotice("error", "Create or open a folder first. Files cannot be stored directly in the Saturn root.");
      return;
    }
    setPending(true);
    try {
      for (const file of files) {
        if (overwrite !== undefined && file.name !== overwrite.name) {
          addNotice("error", `Overwrite file must be named ${overwrite.name}.`);
          continue;
        }
        setUploadProgress(0);
        await uploadFile(file, folderId, overwrite?.id, setUploadProgress);
      }
      addNotice("success", overwrite === undefined ? "Upload committed and verified." : "File overwritten; the previous version is retained.");
      await reload();
    } catch (error) {
      handleError(error, "Upload failed before a visible commit.");
    } finally {
      setPending(false);
      setUploadProgress(undefined);
      if (uploadInput.current !== null) uploadInput.current.value = "";
      if (overwriteInput.current !== null) overwriteInput.current.value = "";
    }
  };

  const submitForm = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form === undefined || pending) return;
    setPending(true);
    try {
      if (form === "folder") await api.createFolder(folderId, formName);
      else if (single !== undefined && form === "rename") await api.move(single.id, folderId, formName);
      else if (single !== undefined && form === "move") await api.move(single.id, destinationId, formName || undefined);
      else if (single !== undefined && form === "copy") await api.copy(single.id, destinationId, formName || undefined);
      addNotice("success", `${form[0]?.toUpperCase() ?? ""}${form.slice(1)} completed.`);
      setForm(undefined);
      setFormName("");
      setDestinationId("");
      await reload();
    } catch (error) {
      handleError(error);
    } finally {
      setPending(false);
    }
  };

  const trashSelected = async () => {
    setPending(true);
    try {
      for (const item of selectedItems) await api.trashResource(item.id);
      addNotice("success", `${String(selectedItems.length)} item(s) moved to reversible trash.`);
      setConfirmTrash(false);
      await reload();
    } catch (error) {
      handleError(error, "The selection could not be moved to trash.");
    } finally {
      setPending(false);
    }
  };

  const showVersions = async (resource: Resource) => {
    try {
      setVersions({ resource, items: await api.versions(resource.id) });
    } catch (error) {
      handleError(error, "Versions could not be loaded.");
    }
  };

  const restoreSelectedVersion = async () => {
    if (versions === undefined || restoreVersion === undefined) return;
    setPending(true);
    try {
      await api.restoreVersion(versions.resource.id, restoreVersion.id);
      addNotice("success", "Version restored; the replaced current file was archived.");
      setRestoreVersion(undefined);
      setVersions(undefined);
      await reload();
    } catch (error) {
      handleError(error, "Version restore failed.");
    } finally {
      setPending(false);
    }
  };

  const useInLaboratory = async () => {
    if (single?.type !== "file") return;
    setPending(true);
    try {
      const asset = await api.createLaboratoryAsset({ resourceId: single.id, mode: "private" });
      setLaboratoryFragment((await api.laboratoryFragment(asset.id)).fragment);
      addNotice("success", "Private Laboratory asset created with a stable Gateway URL.");
    } catch {
      addNotice("error", "Recent owner proof is required to create a Laboratory asset.");
    } finally { setPending(false); }
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    if (atStorageRoot) {
      addNotice("error", "Create or open a folder first. Files cannot be stored directly in the Saturn root.");
      return;
    }
    void performUpload([...event.dataTransfer.files]);
  };

  return (
    <section className="workspace" aria-labelledby="workspace-title" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
      <header className="workspace__head">
        <div>
          <p className="eyebrow">Owner workspace</p>
          <h1 id="workspace-title" className="page-title">{title}</h1>
        </div>
        {uploadProgress === undefined ? null : <div className="upload-progress" role="status">Uploading {Math.round(uploadProgress * 100)}%</div>}
      </header>
      <nav className="breadcrumbs" aria-label="Folder breadcrumbs">
        {breadcrumbs.map((item, index) => <button type="button" key={`${item.id}-${String(index)}`} onClick={() => navigateBreadcrumb(index)}>{item.name}</button>)}
        <span>{folder?.name ?? title}</span>
      </nav>
      <CollectionToolbar search={search} setSearch={setSearch} count={`${String(visible.length)} of ${String(items.length)}`}>
        <button className="button" type="button" onClick={() => { setForm("folder"); setFormName(""); }}>New folder</button>
        <button className="button button--primary" type="button" onClick={() => uploadInput.current?.click()} disabled={pending || atStorageRoot}>Upload</button>
        <input ref={uploadInput} aria-label="Choose files to upload" className="visually-hidden-input" type="file" multiple onChange={(event) => void performUpload([...event.target.files ?? []])} />
      </CollectionToolbar>
      <div className="selection-bar" role="toolbar" aria-label="Selection actions">
        <span>{selectedItems.length === 0 ? "No selection" : `${String(selectedItems.length)} selected`}</span>
        <button type="button" disabled={single === undefined} onClick={() => { if (single?.type === "folder") openFolder(single); }}>Open</button>
        <button type="button" disabled={single?.type !== "file"} onClick={() => { if (single !== undefined) window.location.assign(downloadUrl(single.id)); }}>Download</button>
        <button type="button" disabled={single?.type !== "file"} onClick={() => { if (single !== undefined) setPreview(single); }}>Preview</button>
        <button type="button" disabled={single?.type !== "file"} onClick={() => { if (single !== undefined) void showVersions(single); }}>Versions</button>
        <button type="button" disabled={single?.type !== "file" || pending} onClick={() => void useInLaboratory()}>Use in Laboratory</button>
        <button type="button" disabled={single?.type !== "file" || pending} onClick={() => overwriteInput.current?.click()}>Overwrite</button>
        <input ref={overwriteInput} aria-label="Choose replacement file" className="visually-hidden-input" type="file" onChange={(event) => { if (single !== undefined) void performUpload([...event.target.files ?? []], single); }} />
        <button type="button" disabled={single === undefined} onClick={() => { if (single !== undefined) { setForm("rename"); setFormName(single.name); } }}>Rename</button>
        <button type="button" disabled={single === undefined || singleProtectedRoot} onClick={() => { if (single !== undefined) { setForm("move"); setDestinationId(folderId); setFormName(single.name); } }}>Move</button>
        <button type="button" disabled={single === undefined || singleProtectedRoot} onClick={() => { if (single !== undefined) { setForm("copy"); setDestinationId(folderId); setFormName(single.name); } }}>Copy</button>
        <button className="danger-link" type="button" disabled={selectedItems.length === 0 || selectedProtectedRoot} onClick={() => setConfirmTrash(true)}>Trash</button>
      </div>
      <div className="collection" tabIndex={0} onKeyDown={(event) => { if (event.key === "Delete" && selectedItems.length > 0 && !selectedProtectedRoot) setConfirmTrash(true); }}>
        <div className="file-row file-row--head">
          <span aria-hidden="true" />
          <span>Name</span><span>Type</span><span>Size</span><span>Modified</span>
        </div>
        {loading ? <p className="empty-state">Loading folder…</p> : visible.length === 0 ? <p className="empty-state">{atStorageRoot ? "No root folders are available. Create one to get started." : "No matching items. Drop files here or create a folder."}</p> : visible.map((item) => (
          <div className={`file-row ${selected.has(item.id) ? "file-row--selected" : ""}`} key={item.id} onDoubleClick={() => item.type === "folder" ? openFolder(item) : setPreview(item)}>
            <input
              type="checkbox"
              aria-label={`Select ${item.name}`}
              checked={selected.has(item.id)}
              onChange={() => setSelected((current) => {
                const next = new Set(current);
                if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                return next;
              })}
            />
            <button className="file-name" type="button" onClick={() => item.type === "folder" ? openFolder(item) : setSelected(new Set([item.id]))}>
              <span aria-hidden="true">{item.type === "folder" ? "□" : "·"}</span>{item.name}
            </button>
            <span>{item.type === "folder" ? "Folder" : item.mimeType ?? "File"}</span>
            <span>{item.type === "folder" ? "—" : formatBytes(item.sizeBytes)}</span>
            <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString()}</time>
          </div>
        ))}
      </div>
      <p className="drop-hint">{atStorageRoot ? "Create arbitrary folders here, then open one to upload files. Preinstalled folders can be renamed but not moved or deleted." : "Drag and drop files anywhere in this workspace to upload into the current folder."}</p>

      {form === undefined ? null : (
        <Dialog title={form === "folder" ? "Create folder" : `${form[0]?.toUpperCase() ?? ""}${form.slice(1)} ${single?.name ?? "item"}`} onClose={() => setForm(undefined)}>
          <form className="dialog-form" onSubmit={(event) => void submitForm(event)}>
            {form === "move" || form === "copy" ? (
              <label>Destination folder ID<input value={destinationId} onChange={(event) => setDestinationId(event.target.value)} required autoComplete="off" /></label>
            ) : null}
            <label>{form === "folder" ? "Folder name" : "Name"}<input value={formName} onChange={(event) => setFormName(event.target.value)} required autoComplete="off" autoFocus /></label>
            <div className="dialog__actions"><button className="button" type="button" onClick={() => setForm(undefined)}>Cancel</button><button className="button button--primary" type="submit" disabled={pending}>Apply</button></div>
          </form>
        </Dialog>
      )}
      {confirmTrash ? <ConfirmDialog title="Move selection to trash" description={`${String(selectedItems.length)} item(s) will leave this folder. Bytes remain stored and can be restored until retention expires.`} confirmLabel="Move to trash" danger pending={pending} onConfirm={() => void trashSelected()} onClose={() => setConfirmTrash(false)} /> : null}
      {versions === undefined ? null : (
        <Dialog title={`Versions — ${versions.resource.name}`} description="Restoring a version archives the current bytes first." onClose={() => setVersions(undefined)}>
          <div className="version-list">
            {versions.items.length === 0 ? <p className="empty-state">No historical versions.</p> : versions.items.map((version) => (
              <div className="version-row" key={version.id}>
                <div><strong>{version.reason}</strong><span>{new Date(version.createdAt).toLocaleString()} · {formatBytes(version.sizeBytes)}</span></div>
                <button className="button" type="button" onClick={() => setRestoreVersion(version)}>Restore</button>
              </div>
            ))}
          </div>
        </Dialog>
      )}
      {restoreVersion === undefined ? null : <ConfirmDialog title="Restore historical version" description="The selected version becomes current. The current bytes are archived as another reversible version." confirmLabel="Restore version" pending={pending} onConfirm={() => void restoreSelectedVersion()} onClose={() => setRestoreVersion(undefined)} />}
      {laboratoryFragment === undefined ? null : <Dialog title="Laboratory fragment" description="Copy this Gateway-owned fragment. It contains no Storage Box hostname, SFTP path or share token." onClose={() => setLaboratoryFragment(undefined)}><textarea className="fragment-output" value={laboratoryFragment} readOnly rows={5} aria-label="Laboratory fragment" /><div className="dialog__actions"><button className="button button--primary" type="button" onClick={() => void navigator.clipboard.writeText(laboratoryFragment)}>Copy fragment</button></div></Dialog>}
      {preview === undefined ? null : (
        <Dialog title={`Preview — ${preview.name}`} description="Only allow-listed content types render inline. Everything else remains download-only." onClose={() => setPreview(undefined)}>
          <iframe className="preview-frame" title={`Preview of ${preview.name}`} src={downloadUrl(preview.id, true)} sandbox="allow-same-origin" />
          <div className="dialog__actions"><a className="button" href={downloadUrl(preview.id)}>Download instead</a></div>
        </Dialog>
      )}
    </section>
  );
}

function TrashView({ addNotice, onUnauthorized }: { readonly addNotice: (kind: Notice["kind"], message: string) => void; readonly onUnauthorized: () => void }) {
  const [items, setItems] = useState<readonly Resource[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Resource | undefined>();
  const [pending, setPending] = useState(false);
  const load = async () => {
    try { setItems(await api.trash()); } catch (error) { if (error instanceof ApiError && error.status === 401) onUnauthorized(); else addNotice("error", "Trash could not be loaded."); }
  };
  useEffect(() => { void load(); }, []);
  const visible = items.filter((item) => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const restore = async () => {
    if (selected === undefined) return;
    setPending(true);
    try { await api.restoreResource(selected.id); addNotice("success", `${selected.name} restored to its original folder.`); setSelected(undefined); await load(); }
    catch (error) { if (error instanceof ApiError && error.status === 401) onUnauthorized(); else addNotice("error", "Restore failed; no bytes were discarded."); }
    finally { setPending(false); }
  };
  return (
    <section className="workspace" aria-labelledby="trash-title">
      <header className="workspace__head"><div><p className="eyebrow">Reversible deletion</p><h1 className="page-title" id="trash-title">Trash</h1></div></header>
      <CollectionToolbar search={search} setSearch={setSearch} count={`${String(visible.length)} item(s)`}><span className="muted">90-day default retention</span></CollectionToolbar>
      <div className="collection">
        {visible.length === 0 ? <p className="empty-state">Trash is empty.</p> : visible.map((item) => (
          <button className="trash-row" type="button" key={item.id} onClick={() => setSelected(item)}>
            <span>{item.name}</span><span>{item.trashedFromParentId ?? "Original folder unavailable"}</span><span>{item.purgeAfter === undefined ? "Manual retention" : `Eligible after ${new Date(item.purgeAfter).toLocaleString()}`}</span>
          </button>
        ))}
      </div>
      {selected === undefined ? null : <ConfirmDialog title={`Restore ${selected.name}`} description="The item returns to its original folder and keeps the same stable resource ID. Restore stops if the original name is occupied." confirmLabel="Restore" pending={pending} onConfirm={() => void restore()} onClose={() => setSelected(undefined)} />}
    </section>
  );
}

function ActivityView({ onUnauthorized }: { readonly onUnauthorized: () => void }) {
  const [events, setEvents] = useState<readonly AuditEvent[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void api.activity().then(setEvents).catch((error: unknown) => { if (error instanceof ApiError && error.status === 401) onUnauthorized(); }).finally(() => setLoading(false));
  }, []);
  const visible = events.filter((event) => event.action.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return (
    <section className="workspace" aria-labelledby="activity-title">
      <header className="workspace__head"><div><p className="eyebrow">Append-only record</p><h1 className="page-title" id="activity-title">Activity</h1></div><a className="button" href="/api/v1/activity/export?limit=10000">Export JSONL</a></header>
      <CollectionToolbar search={search} setSearch={setSearch} count={`${String(visible.length)} of ${String(events.length)}`}><button className="button" type="button" onClick={() => void api.activity().then(setEvents)}>Refresh</button></CollectionToolbar>
      <div className="collection activity-list">
        {loading ? <p className="empty-state">Loading activity…</p> : visible.map((event) => (
          <article className="activity-row" key={event.sequence}>
            <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
            <strong>{event.action}</strong><span className={`outcome outcome--${event.outcome}`}>{event.outcome}</span>
            <code>{event.resourceId ?? "system"}</code>
          </article>
        ))}
      </div>
    </section>
  );
}

function SharedView({ addNotice, onAnonymous }: { readonly addNotice: (kind: Notice["kind"], message: string) => void; readonly onAnonymous: () => void }) {
  const [shares, setShares] = useState<readonly ShareInfo[]>([]);
  const [resourceId, setResourceId] = useState("");
  const [mode, setMode] = useState<ShareInfo["mode"]>("download");
  const [password, setPassword] = useState("");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [pending, setPending] = useState(false);
  const [createdUrl, setCreatedUrl] = useState("");
  const load = async () => {
    try { setShares(await api.shares()); }
    catch (error) { if (error instanceof ApiError && error.status === 401) onAnonymous(); else addNotice("error", "Shares could not be loaded."); }
  };
  useEffect(() => { void load(); }, []);
  const create = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); setPending(true); setCreatedUrl("");
    try {
      const created = await api.createShare({
        resourceId,
        mode,
        ...(password ? { password } : {}),
        ...(maxDownloads ? { maxDownloads: Number(maxDownloads) } : {}),
      });
      setCreatedUrl(created.url); setPassword(""); await load();
      addNotice("success", "Share created. Its capability URL is shown only in this view now.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onAnonymous();
      else addNotice("error", "Share creation requires a compatible active resource and recent owner proof.");
    } finally { setPending(false); }
  };
  const revoke = async (id: string) => {
    setPending(true);
    try { await api.revokeShare(id); await load(); addNotice("success", "Share revoked immediately."); }
    catch { addNotice("error", "Share revoke requires recent owner proof."); }
    finally { setPending(false); }
  };
  return (
    <section className="workspace shared" aria-labelledby="shared-title">
      <header className="workspace__head"><div><p className="eyebrow">External read-only access</p><h1 className="page-title" id="shared-title">Shared</h1></div></header>
      <section className="settings-section">
        <h2>Create share</h2><p className="muted">Use a stable resource ID. The generated capability URL is disclosed once and never appears in this list.</p>
        <form className="share-form" onSubmit={(event) => void create(event)}>
          <label>Resource ID<input value={resourceId} onChange={(event) => setResourceId(event.target.value)} required pattern="[0-9a-fA-F-]{36}" /></label>
          <label>Mode<select value={mode} onChange={(event) => setMode(event.target.value as ShareInfo["mode"])}><option value="view">View file</option><option value="download">Download file</option><option value="browse">Browse folder</option><option value="download_folder">Download folder package</option></select></label>
          <label>Optional password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" /></label>
          <label>Optional max downloads<input type="number" value={maxDownloads} onChange={(event) => setMaxDownloads(event.target.value)} min={1} max={1000000} /></label>
          <button className="button button--primary" type="submit" disabled={pending}>Create capability</button>
        </form>
        {createdUrl ? <div className="one-time-code" role="status"><span>Copy this URL now</span><strong className="share-url">{createdUrl}</strong><small>It is held only in page memory and disappears on navigation or refresh.</small></div> : null}
      </section>
      <section className="settings-section"><h2>Active and historical shares</h2>
        <div className="share-list">{shares.length === 0 ? <p className="empty-state">No share records.</p> : shares.map((share) => <article className="share-row" key={share.id}><div><strong>{share.resourceName}</strong><span>{share.mode} · {share.state} · {String(share.downloadCount)} download session(s)</span><small>{share.expiresAt === undefined ? "No expiry" : `Expires ${new Date(share.expiresAt).toLocaleString()}`}</small></div><button className="button button--danger" type="button" onClick={() => void revoke(share.id)} disabled={pending || share.state === "revoked"}>Revoke</button></article>)}</div>
      </section>
    </section>
  );
}

function PublicShareView({ token }: { readonly token: string }) {
  const health = useGatewayHealth();
  const [share, setShare] = useState<ShareInfo | undefined>();
  const [password, setPassword] = useState("");
  const [children, setChildren] = useState<readonly ShareChild[]>([]);
  const [folderId, setFolderId] = useState<string | undefined>();
  const [history, setHistory] = useState<readonly string[]>([]);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [packageReady, setPackageReady] = useState(false);
  const loadChildren = async (parentId?: string) => { setChildren(await publicShareApi.children(token, parentId)); setFolderId(parentId); };
  useEffect(() => {
    void publicShareApi.metadata(token).then((value) => { setShare(value); if (!value.locked && value.resourceType === "folder") void loadChildren(); }).catch(() => setMessage("This share is unavailable."));
  }, [token]);
  const unlock = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); setPending(true); setMessage("");
    try { const value = await publicShareApi.unlock(token, password); setPassword(""); setShare(value); if (value.resourceType === "folder") await loadChildren(); }
    catch (error) { setPassword(""); setMessage(error instanceof ApiError && error.status === 429 ? "Too many attempts. Try later." : "The share password was not accepted."); }
    finally { setPending(false); }
  };
  const openFolder = async (id: string) => { setPending(true); try { setHistory((current) => [...current, folderId ?? ""]); await loadChildren(id); } catch { setMessage("That folder is outside this share."); } finally { setPending(false); } };
  const back = async () => { const next = history.at(-1); if (next === undefined) return; setHistory((current) => current.slice(0, -1)); await loadChildren(next || undefined); };
  const prepare = async () => { setPending(true); try { const value = await publicShareApi.preparePackage(token); setPackageReady(value.state === "ready"); } catch { setMessage("The folder package could not be prepared within its limits."); } finally { setPending(false); } };
  return (
    <main className="share-public-view"><section className="share-public-panel" aria-labelledby="public-share-title">
      <header className="drop-panel__head"><div><p className="eyebrow">Read-only capability</p><h1 id="public-share-title" className="wordmark wordmark--share">Saturn Share</h1></div><HealthLabel state={health} /></header>
      {share === undefined ? <p className="empty-state">{message || "Checking share…"}</p> : share.locked ? <form className="drop-redeem" onSubmit={(event) => void unlock(event)}><p className="muted">This capability is password protected.</p><label>Share password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required autoFocus /></label><button className="button button--primary" type="submit" disabled={pending}>Unlock</button><p className="form-error" role="alert">{message}</p></form> : <div className="share-public-content">
        <div className="drop-policy"><strong>READ ONLY</strong><span>{share.mode.replace("_", " ")} · expires {share.expiresAt === undefined ? "by owner revoke" : new Date(share.expiresAt).toLocaleString()}</span></div>
        <h2>{share.resourceName}</h2><p className="muted">View-only changes browser presentation; any content delivered to a browser can still be copied. Saturn does not promise impossible download prevention.</p>
        {share.resourceType === "file" ? <a className="button button--primary" href={publicShareApi.contentUrl(token)}>{share.mode === "view" ? "Open view" : `Download · ${formatBytes(share.resourceSize)}`}</a> : <>
          <div className="inline-actions">{history.length > 0 ? <button className="button" type="button" onClick={() => void back()}>Back</button> : null}{share.mode === "download_folder" ? packageReady ? <a className="button button--primary" href={publicShareApi.packageUrl(token)}>Download prepared ZIP</a> : <button className="button button--primary" type="button" onClick={() => void prepare()} disabled={pending}>Prepare bounded ZIP</button> : null}</div>
          <div className="share-browser">{children.length === 0 ? <p className="empty-state">This shared folder is empty.</p> : children.map((child) => <button type="button" key={child.id} onClick={() => child.type === "folder" ? void openFolder(child.id) : undefined} disabled={pending || child.type === "file"}><span>{child.type === "folder" ? "DIR" : "FILE"}</span><strong>{child.name}</strong><small>{child.type === "file" ? formatBytes(child.sizeBytes) : "Open folder"}</small></button>)}</div>
        </>}
        <p className="form-error" role="alert">{message}</p>
      </div>}
    </section></main>
  );
}

function LaboratoryView({ addNotice }: { readonly addNotice: (kind: Notice["kind"], message: string) => void }) {
  const [assets, setAssets] = useState<readonly LaboratoryAssetInfo[]>([]);
  const [clients, setClients] = useState<readonly LaboratoryClientInfo[]>([]);
  const [resourceId, setResourceId] = useState(""); const [mode, setMode] = useState<LaboratoryAssetInfo["mode"]>("private"); const [assetLabel, setAssetLabel] = useState(""); const [disposition, setDisposition] = useState<LaboratoryAssetInfo["disposition"]>("attachment"); const [clientName, setClientName] = useState(""); const [token, setToken] = useState<string | undefined>(); const [fragment, setFragment] = useState<string | undefined>(); const [pending, setPending] = useState(false);
  const load = async () => { try { const [nextAssets, nextClients] = await Promise.all([api.laboratoryAssets(), api.laboratoryClients()]); setAssets(nextAssets); setClients(nextClients); } catch { addNotice("error", "Laboratory registry could not be loaded."); } };
  useEffect(() => { void load(); }, []);
  const createAsset = async (event: SyntheticEvent<HTMLFormElement>) => { event.preventDefault(); setPending(true); try { const created = await api.createLaboratoryAsset({ resourceId, mode, ...(assetLabel.trim() ? { label: assetLabel } : {}), disposition }); setResourceId(""); setAssetLabel(""); setFragment((await api.laboratoryFragment(created.id)).fragment); await load(); addNotice("success", "Stable Laboratory asset created."); } catch { addNotice("error", "Asset policy rejected the request or recent owner proof is missing."); } finally { setPending(false); } };
  const createClient = async (event: SyntheticEvent<HTMLFormElement>) => { event.preventDefault(); setPending(true); try { const created = await api.createLaboratoryClient(clientName); setClientName(""); setToken(created.token); await load(); addNotice("success", "Laboratory client token created for one-time copy."); } catch { addNotice("error", "Recent owner proof is required to create a client."); } finally { setPending(false); } };
  const rotateClient = async (id: string) => { setPending(true); try { const rotated = await api.rotateLaboratoryClient(id); setToken(rotated.token); await load(); } catch { addNotice("error", "Client rotation requires recent owner proof."); } finally { setPending(false); } };
  const revokeClient = async (id: string) => { setPending(true); try { await api.revokeLaboratoryClient(id); await load(); addNotice("success", "Laboratory client revoked."); } catch { addNotice("error", "Client revoke requires recent owner proof."); } finally { setPending(false); } };
  const disableAsset = async (id: string) => { setPending(true); try { await api.disableLaboratoryAsset(id); await load(); addNotice("success", "Asset delivery disabled; source bytes were preserved."); } catch { addNotice("error", "Asset disable requires recent owner proof."); } finally { setPending(false); } };
  const showFragment = async (id: string) => { try { setFragment((await api.laboratoryFragment(id)).fragment); } catch { addNotice("error", "Fragment is unavailable for this asset."); } };
  return <section className="workspace laboratory" aria-labelledby="laboratory-title">
    <header className="workspace__head"><div><p className="eyebrow">Stable Gateway assets</p><h1 className="page-title" id="laboratory-title">Laboratory</h1></div></header>
    <section className="settings-section"><h2>Create asset</h2><p className="muted">Private is the safe default. Public modes require the global switch and an explicitly public resource classification.</p><form className="laboratory-form" onSubmit={(event) => void createAsset(event)}><label>Resource ID<input value={resourceId} onChange={(event) => setResourceId(event.target.value)} required /></label><label>Mode<select value={mode} onChange={(event) => setMode(event.target.value as LaboratoryAssetInfo["mode"])}><option value="private">Private</option><option value="public_immutable">Public immutable</option><option value="public_alias">Public mutable alias</option></select></label><label>Label<input value={assetLabel} onChange={(event) => setAssetLabel(event.target.value)} placeholder="Defaults to filename" /></label><label>Disposition<select value={disposition} onChange={(event) => setDisposition(event.target.value as LaboratoryAssetInfo["disposition"])}><option value="attachment">Attachment</option><option value="inline">Inline</option></select></label><button className="button button--primary" type="submit" disabled={pending}>Create asset</button></form>{fragment === undefined ? null : <div className="fragment-panel" role="status"><label>Gateway fragment<textarea value={fragment} readOnly rows={4} /></label><button className="button" type="button" onClick={() => void navigator.clipboard.writeText(fragment)}>Copy</button></div>}</section>
    <section className="settings-section"><h2>Assets</h2><div className="share-list">{assets.length===0?<p className="empty-state">No Laboratory assets.</p>:assets.map((asset)=><article className="laboratory-row" key={asset.id}><div><strong>{asset.label}</strong><span>{asset.mode} · {asset.state}</span><small>{asset.id} · {asset.publicFilename}{asset.pinnedVersionId===undefined?"":" · pinned"}</small></div><div className="inline-actions"><button className="button" type="button" onClick={() => void showFragment(asset.id)} disabled={asset.state!=="active"}>Fragment</button><button className="button button--danger" type="button" onClick={() => void disableAsset(asset.id)} disabled={pending||asset.state!=="active"}>Disable</button></div></article>)}</div></section>
    <section className="settings-section"><h2>Private Laboratory clients</h2><p className="muted">Tokens can read private asset URLs only. They cannot list Drive, mutate assets or access Storage Box.</p><form className="laboratory-client-form" onSubmit={(event) => void createClient(event)}><label>Client name<input value={clientName} onChange={(event) => setClientName(event.target.value)} required /></label><button className="button button--primary" type="submit" disabled={pending}>Create token</button></form>{token===undefined?null:<div className="one-time-code" role="status"><span>Copy this Bearer token now</span><strong>{token}</strong><small>Only an HMAC verifier is persisted.</small></div>}<div className="share-list">{clients.length===0?<p className="empty-state">No Laboratory clients.</p>:clients.map((client)=><article className="laboratory-row" key={client.id}><div><strong>{client.name}</strong><span>{client.state}</span><small>{client.lastUsedAt===undefined?"Never used":`Last used ${new Date(client.lastUsedAt).toLocaleString()}`}</small></div><div className="inline-actions"><button className="button" type="button" onClick={() => void rotateClient(client.id)} disabled={pending||client.state!=="active"}>Rotate</button><button className="button button--danger" type="button" onClick={() => void revokeClient(client.id)} disabled={pending||client.state!=="active"}>Revoke</button></div></article>)}</div></section>
  </section>;
}

function SettingsView({ preferences, setPreferences, addNotice, onAnonymous }: {
  readonly preferences: Omit<OwnerPreferences, "updatedAt">;
  readonly setPreferences: (value: Omit<OwnerPreferences, "updatedAt">) => void;
  readonly addNotice: (kind: Notice["kind"], message: string) => void;
  readonly onAnonymous: () => void;
}) {
  const [draft, setDraft] = useState(preferences);
  const [accessKey, setAccessKey] = useState("");
  const [pending, setPending] = useState(false);
  const [reauthed, setReauthed] = useState(false);
  const [revokeDialog, setRevokeDialog] = useState(false);
  const [telegram, setTelegram] = useState<TelegramStatus | undefined>();
  const [linkCode, setLinkCode] = useState<{ readonly code: string; readonly expiresAt: string } | undefined>();
  const [unlinkDialog, setUnlinkDialog] = useState(false);
  const [devices, setDevices] = useState<readonly DeviceInfo[]>([]);
  const [deviceName, setDeviceName] = useState("");
  const [deviceScopes, setDeviceScopes] = useState<readonly string[]>([]);
  const [deviceToken, setDeviceToken] = useState<string | undefined>();
  const [backupServices, setBackupServices] = useState<readonly BackupServiceInfo[]>([]);
  const [backupName, setBackupName] = useState("");
  const [backupSlug, setBackupSlug] = useState("");
  const [backupToken, setBackupToken] = useState<string | undefined>();
  const loadTelegram = async () => { try { setTelegram(await api.telegramStatus()); } catch { addNotice("error", "Telegram status could not be loaded."); } };
  const loadDevices = async () => { try { setDevices(await api.devices()); } catch { addNotice("error", "Device list could not be loaded."); } };
  const loadBackupServices = async () => { try { setBackupServices(await api.backupServices()); } catch { addNotice("error", "Backup producer dashboard could not be loaded."); } };
  useEffect(() => { void loadTelegram(); void loadDevices(); void loadBackupServices(); }, []);
  const saveAppearance = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); setPending(true);
    try { const saved = await api.updatePreferences(draft); setPreferences(appearancePreferences(saved)); addNotice("success", "Appearance updated across the owner workspace."); }
    catch { addNotice("error", "Appearance could not be saved."); }
    finally { setPending(false); }
  };
  const reauthenticate = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!accessKey) return; setPending(true);
    try { await api.reauthenticate(accessKey); setAccessKey(""); setReauthed(true); addNotice("success", "Recent owner proof accepted; the session was rotated."); }
    catch { setAccessKey(""); addNotice("error", "Re-authentication failed."); }
    finally { setPending(false); }
  };
  const revoke = async () => {
    setPending(true);
    try { const result = await api.revokeSessions(); addNotice("info", `${String(result.revoked)} owner session(s) revoked.`); onAnonymous(); }
    catch { addNotice("error", reauthed ? "Session revocation failed." : "Re-authenticate before revoking all sessions."); setRevokeDialog(false); }
    finally { setPending(false); }
  };
  const createLink = async () => {
    setPending(true);
    try { setLinkCode(await api.createTelegramLinkChallenge()); addNotice("info", "A single-use Telegram link code was created."); }
    catch { addNotice("error", "Re-authenticate before creating a Telegram link code."); }
    finally { setPending(false); }
  };
  const unlink = async () => {
    setPending(true);
    try { await api.unlinkTelegram(); setLinkCode(undefined); setUnlinkDialog(false); await loadTelegram(); addNotice("success", "Telegram identity and active Drop access were revoked."); }
    catch { setUnlinkDialog(false); addNotice("error", "Telegram unlink requires recent owner proof."); }
    finally { setPending(false); }
  };
  const toggleDeviceScope = (id: string) => setDeviceScopes((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const createDevice = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!deviceName || deviceScopes.length === 0) return; setPending(true);
    try {
      const created = await api.createDevice({ name: deviceName, scopeIds: deviceScopes, rights: { read: true, write: true, move: true, delete: true } });
      setDeviceToken(created.token); setDeviceName(""); setDeviceScopes([]); await loadDevices(); addNotice("success", "Scoped WebDAV device created.");
    } catch { addNotice("error", "Re-authenticate and select at least one device scope."); }
    finally { setPending(false); }
  };
  const revokeDevice = async (id: string) => {
    setPending(true);
    try { await api.revokeDevice(id); await loadDevices(); addNotice("success", "Device access revoked."); }
    catch { addNotice("error", "Device revoke requires recent owner proof."); }
    finally { setPending(false); }
  };
  const createBackupService = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!backupName || !backupSlug) return; setPending(true);
    try { const created = await api.createBackupService({ name: backupName, slug: backupSlug }); setBackupToken(created.token); setBackupName(""); setBackupSlug(""); await loadBackupServices(); addNotice("success", "Backup producer identity created."); }
    catch { addNotice("error", "Re-authenticate and use a unique lowercase producer slug."); } finally { setPending(false); }
  };
  const rotateBackupService = async (id: string) => { setPending(true); try { const rotated = await api.rotateBackupService(id); setBackupToken(rotated.token); await loadBackupServices(); addNotice("success", "Producer token rotated with a bounded overlap window."); } catch { addNotice("error", "Producer token rotation requires recent owner proof."); } finally { setPending(false); } };
  const revokeBackupService = async (id: string) => { setPending(true); try { await api.revokeBackupService(id); await loadBackupServices(); addNotice("success", "Producer access revoked; committed backups were preserved."); } catch { addNotice("error", "Producer revoke requires recent owner proof."); } finally { setPending(false); } };
  return (
    <section className="workspace settings" aria-labelledby="settings-title">
      <header className="workspace__head"><div><p className="eyebrow">Owner controls</p><h1 className="page-title" id="settings-title">Settings</h1></div></header>
      <section className="settings-section">
        <h2>Appearance</h2><p className="muted">Exactly three theme inputs drive login and authenticated views.</p>
        <form className="theme-form" onSubmit={(event) => void saveAppearance(event)}>
          {(["darkColor", "lightColor", "accentColor"] as const).map((field) => (
            <label key={field}>{field === "darkColor" ? "Dark" : field === "lightColor" ? "Light" : "Accent"}<span><input type="color" value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} /><input value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} pattern="#[0-9a-fA-F]{6}" /></span></label>
          ))}
          <div className="inline-actions"><button className="button" type="button" onClick={() => setDraft(defaultPreferences)}>Reset</button><button className="button button--primary" type="submit" disabled={pending}>Save appearance</button></div>
        </form>
      </section>
      <section className="settings-section">
        <h2>Telegram and Drop</h2>
        <p className="muted">Provider: {telegram?.provider.state ?? "checking"}. Bound identity: {telegram?.binding === undefined ? "none" : telegram.binding.displayName ?? telegram.binding.userId}.</p>
        {linkCode === undefined ? null : <div className="one-time-code" role="status"><span>Send to the bot</span><strong>/link {linkCode.code}</strong><small>Expires {new Date(linkCode.expiresAt).toLocaleTimeString()}. It is not stored in the browser.</small></div>}
        <div className="inline-actions">
          <button className="button" type="button" onClick={() => void loadTelegram()} disabled={pending}>Refresh</button>
          <button className="button button--primary" type="button" onClick={() => void createLink()} disabled={pending || !reauthed}>Create link code</button>
          <button className="button button--danger" type="button" onClick={() => setUnlinkDialog(true)} disabled={pending || !reauthed || telegram?.binding === undefined}>Unlink</button>
        </div>
      </section>
      <section className="settings-section">
        <h2>Recent owner proof</h2><p className="muted">Required before purge, KeePass access, secret rotation and revoking all sessions. The field always opens empty.</p>
        <form className="reauth-form" onSubmit={(event) => void reauthenticate(event)}>
          <label>Owner access key<input type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} autoComplete="current-password" required /></label>
          <button className="button" type="submit" disabled={pending || !accessKey}>Re-authenticate</button>
        </form>
      </section>
      <section className="settings-section">
        <h2>WebDAV devices</h2><p className="muted">Each client receives a separate revocable password and only the roots selected below. Storage Box credentials are never disclosed.</p>
        <form className="device-form" onSubmit={(event) => void createDevice(event)}>
          <label>Device name<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} required /></label>
          <fieldset><legend>Allowed roots</legend>{[{ id: MASTERMIND_RESOURCE_ID, label: "Mastermind" }, { id: SYNC_RESOURCE_ID, label: "Sync" }, { id: VOLT_RESOURCE_ID, label: "KeePass / Volt" }].map(({ id, label }) => <label key={id}><input type="checkbox" checked={deviceScopes.includes(id)} onChange={() => toggleDeviceScope(id)} />{label}</label>)}</fieldset>
          <button className="button button--primary" type="submit" disabled={pending || !reauthed || deviceScopes.length === 0}>Create device password</button>
        </form>
        {deviceToken === undefined ? null : <div className="one-time-code" role="status"><span>Copy this WebDAV password now</span><strong>{deviceToken}</strong><small>Endpoint: /dav/ · username may be the device name. This password is held only in page memory.</small></div>}
        <div className="share-list">{devices.length === 0 ? <p className="empty-state">No device records.</p> : devices.map((device) => <article className="share-row" key={device.id}><div><strong>{device.name}</strong><span>{device.state} · {device.scopeIds.length} scoped root(s)</span><small>{device.lastUsedAt === undefined ? "Never used" : `Last used ${new Date(device.lastUsedAt).toLocaleString()}`}</small></div><button className="button button--danger" type="button" disabled={pending || device.state !== "active"} onClick={() => void revokeDevice(device.id)}>Revoke</button></article>)}</div>
      </section>
      <section className="settings-section">
        <h2>Backup producers</h2><p className="muted">Each internal service uploads only encrypted, resumable backups to its Gateway-derived namespace. Producer tokens cannot list, read or delete backups.</p>
        <form className="backup-service-form" onSubmit={(event) => void createBackupService(event)}>
          <label>Service name<input value={backupName} onChange={(event) => setBackupName(event.target.value)} maxLength={100} required /></label>
          <label>Immutable slug<input value={backupSlug} onChange={(event) => setBackupSlug(event.target.value.toLowerCase())} pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" maxLength={63} required /></label>
          <button className="button button--primary" type="submit" disabled={pending || !reauthed}>Create producer token</button>
        </form>
        {backupToken === undefined ? null : <div className="one-time-code" role="status"><span>Copy this producer Bearer token now</span><strong>{backupToken}</strong><small>It is held only in page memory. Storage Box credentials and historical backup bytes are never exposed.</small></div>}
        <div className="share-list">{backupServices.length === 0 ? <p className="empty-state">No backup producers enabled.</p> : backupServices.map((service) => <article className="backup-service-row" key={service.id}><div><strong>{service.name}</strong><span>{service.slug} · {service.state} · {service.fresh ? "fresh" : "stale/no success"}</span><small>{formatBytes(service.usage.storedBytes)} stored · {String(service.usage.activeRuns)} active · {String(service.usage.failedRuns)} failed · restore {service.lastRestoreTest?.outcome ?? "not tested"}</small></div><div className="inline-actions"><button className="button" type="button" disabled={pending || service.state !== "active"} onClick={() => void rotateBackupService(service.id)}>Rotate</button><button className="button button--danger" type="button" disabled={pending || service.state !== "active"} onClick={() => void revokeBackupService(service.id)}>Revoke</button></div></article>)}</div>
      </section>
      <section className="settings-section settings-section--danger">
        <h2>Sessions</h2><p className="muted">Revoke every active browser session, including this one. Stored files and Storage Box access are unchanged.</p>
        <button className="button button--danger" type="button" onClick={() => setRevokeDialog(true)}>Revoke all sessions</button>
      </section>
      {revokeDialog ? <ConfirmDialog title="Revoke all owner sessions" description="Every browser session is invalidated server-side. Files remain stored and the bootstrap access key remains available for a new login." confirmLabel="Revoke sessions" danger pending={pending} onConfirm={() => void revoke()} onClose={() => setRevokeDialog(false)} /> : null}
      {unlinkDialog ? <ConfirmDialog title="Unlink Telegram" description="The stable Telegram binding, pending Drop codes and all active Drop sessions are revoked. Committed Drop Point files remain unchanged." confirmLabel="Unlink and revoke Drop" danger pending={pending} onConfirm={() => void unlink()} onClose={() => setUnlinkDialog(false)} /> : null}
    </section>
  );
}

function AuthenticatedApp({ health, onAnonymous }: { readonly health: GatewayState; readonly onAnonymous: () => void }) {
  const [view, setView] = useState<ViewName>("files");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const [preferences, setPreferences] = useState<Omit<OwnerPreferences, "updatedAt">>(defaultPreferences);
  const quickUpload = useRef<HTMLInputElement>(null);
  const [quickPending, setQuickPending] = useState(false);
  const addNotice = (kind: Notice["kind"], message: string) => {
    const id = crypto.randomUUID();
    setNotices((current) => [...current.slice(-4), { id, kind, message }]);
    if (kind !== "error") window.setTimeout(() => setNotices((current) => current.filter((item) => item.id !== id)), 4_500);
  };
  useEffect(() => {
    void api.preferences().then((value) => setPreferences(appearancePreferences(value))).catch(() => undefined);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--dark", preferences.darkColor);
    root.style.setProperty("--light", preferences.lightColor);
    root.style.setProperty("--accent", preferences.accentColor);
  }, [preferences]);
  const navigate = (next: ViewName) => { setView(next); setMobileMenu(false); };
  const runQuickUpload = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setQuickPending(true);
    try { for (const file of files) await uploadFile(file, DROP_POINT_RESOURCE_ID, undefined, () => undefined); addNotice("success", "Quick upload committed to Drop Point."); }
    catch (error) { if (error instanceof ApiError && error.status === 401) onAnonymous(); else addNotice("error", "Quick upload failed before commit."); }
    finally { setQuickPending(false); if (quickUpload.current !== null) quickUpload.current.value = ""; }
  };
  const logout = async () => {
    try { await api.logout(); } finally { onAnonymous(); }
  };
  const nav: ReadonlyArray<{ readonly id: ViewName; readonly label: string; readonly marker: string }> = [
    { id: "files", label: "Files", marker: "01" },
    { id: "laboratory", label: "Laboratory", marker: "02" },
    { id: "inbox", label: "Drop Point", marker: "03" },
    { id: "shared", label: "Shared", marker: "04" },
    { id: "trash", label: "Trash", marker: "05" },
    { id: "activity", label: "Activity", marker: "06" },
    { id: "settings", label: "Settings", marker: "07" },
  ];
  return (
    <div className="app-shell">
      <button className="mobile-menu-button" type="button" onClick={() => setMobileMenu((value) => !value)} aria-expanded={mobileMenu} aria-controls="primary-navigation">Menu</button>
      <aside className={`sidebar ${mobileMenu ? "sidebar--open" : ""}`} id="primary-navigation">
        <div className="sidebar__brand"><span aria-hidden="true">S</span><strong>Saturn</strong></div>
        <HealthLabel state={health} />
        <nav aria-label="Primary">
          {nav.map((item) => <button type="button" aria-label={item.label} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "nav-item nav-item--active" : "nav-item"} key={item.id} onClick={() => navigate(item.id)}><span aria-hidden="true">{item.marker}</span>{item.label}</button>)}
        </nav>
        <div className="sidebar__bottom"><a href="/docs" aria-disabled="true">Documentation</a><button type="button" onClick={() => void logout()}>Logout</button></div>
      </aside>
      <main className="content" id="main-content">
        <div className="global-actions"><button className="button button--primary" type="button" disabled={quickPending} onClick={() => quickUpload.current?.click()}>{quickPending ? "Uploading…" : "Quick upload"}</button><input ref={quickUpload} aria-label="Choose files for quick upload" className="visually-hidden-input" type="file" multiple onChange={(event) => void runQuickUpload([...event.target.files ?? []])} /></div>
        {view === "files" ? <FilesView initialFolderId={ROOT_RESOURCE_ID} title="Files" addNotice={addNotice} onUnauthorized={onAnonymous} /> : null}
        {view === "laboratory" ? <LaboratoryView addNotice={addNotice} /> : null}
        {view === "inbox" ? <FilesView initialFolderId={DROP_POINT_RESOURCE_ID} title="Drop Point" addNotice={addNotice} onUnauthorized={onAnonymous} /> : null}
        {view === "shared" ? <SharedView addNotice={addNotice} onAnonymous={onAnonymous} /> : null}
        {view === "trash" ? <TrashView addNotice={addNotice} onUnauthorized={onAnonymous} /> : null}
        {view === "activity" ? <ActivityView onUnauthorized={onAnonymous} /> : null}
        {view === "settings" ? <SettingsView preferences={preferences} setPreferences={setPreferences} addNotice={addNotice} onAnonymous={onAnonymous} /> : null}
      </main>
      <NoticeStack notices={notices} dismiss={(id) => setNotices((current) => current.filter((item) => item.id !== id))} />
    </div>
  );
}

function OwnerApp() {
  const health = useGatewayHealth();
  const [auth, setAuth] = useState<"checking" | "anonymous" | "authenticated">("checking");
  useEffect(() => {
    let active = true;
    void api.session().then(() => { if (active) setAuth("authenticated"); }).catch(() => { if (active) setAuth("anonymous"); });
    return () => { active = false; };
  }, []);
  if (auth === "checking") return <main className="boot-state" role="status">Opening Saturn…</main>;
  if (auth === "anonymous") return <LoginView health={health} onAuthenticated={() => setAuth("authenticated")} />;
  return <AuthenticatedApp health={health} onAnonymous={() => setAuth("anonymous")} />;
}

function DropApp() {
  return <DropView health={useGatewayHealth()} />;
}

export function App() {
  const route = window.location.pathname.replace(/\/+$/, "");
  if (route === "/drop") return <DropApp />;
  const share = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(route);
  return share?.[1] === undefined ? <OwnerApp /> : <PublicShareView token={share[1]} />;
}
