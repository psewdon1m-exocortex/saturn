import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";
import type { HealthResponse } from "@saturn/contracts";
import DOMPurify from "dompurify";
import { marked } from "marked";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { ApiError, api, downloadRecoverySnapshot, downloadUrl, dropApi, folderDownloadUrl, forgetRecoverableOwnerUpload, publicShareApi, recoverableOwnerUpload, resumeOwnerUpload, uploadDropFile, uploadFile, uploadRecoverySnapshot } from "./api.js";
import {
  BACKUPS_RESOURCE_ID,
  DROP_POINT_RESOURCE_ID,
  LABORATORY_RESOURCE_ID,
  MASTERMIND_RESOURCE_ID,
  VOLT_RESOURCE_ID,
  ROOT_RESOURCE_ID,
  SYNC_RESOURCE_ID,
  type BackupServiceInfo,
  type AuditEventInfo,
  type ArchiveJobInfo,
  type DeviceInfo,
  type FileVersion,
  type GryphonBot,
  type GryphonChallenge,
  type GryphonStatus,
  type KernelStatus,
  type OwnerPreferences,
  type OperatorOverview,
  type RecoveryStatus,
  type RecoveryRestoreCandidate,
  type RecoveryRestoreResult,
  type NeptuneReleaseCheck,
  type NeptuneAgentInfo,
  type NeptuneAvailability,
  type Resource,
  type ShareChild,
  type ShareInfo,
  type DropSessionInfo,
  type DropUploadStatus,
  type StorageConnectionInput,
  type StorageConnectionStatus,
  type UpdateStatus,
} from "./types.js";

const saturnPlanet = "/saturn-favicon.png";

type GatewayState = "checking" | "ready" | "degraded";
type GatewayHealth = { readonly gateway: GatewayState; readonly storage: GatewayState };
type PrimaryViewName = "dashboard" | "files" | "inbox" | "shared" | "synchronization" | "settings" | "trash";
type ViewName = PrimaryViewName | "documentation";
type DashboardCardName = OwnerPreferences["dashboardOrder"][number];
type SettingsCardName = OwnerPreferences["settingsOrder"][number];
type Notice = { readonly id: string; readonly kind: "success" | "error" | "info"; readonly message: string };
type OwnerRoute = { readonly view: ViewName; readonly folderSegments: readonly string[] };
type SortField = "name" | "modified" | "size";
type SortDirection = "ascending" | "descending";
type ResourceClipboard = { readonly operation: "copy" | "cut"; readonly resource: Resource };
type ContextMenuState = { readonly x: number; readonly y: number; readonly resource?: Resource };
type ContextAction = "copy" | "cut" | "paste" | "download" | "folder" | "trash" | "rename" | "share" | "extract" | "compress";
type FileKind = "folder" | "image" | "video" | "audio" | "pdf" | "markdown" | "document" | "archive" | "file";

const NAV_ITEMS: Readonly<Record<PrimaryViewName, { readonly label: string; readonly ordinal: string }>> = {
  dashboard: { label: "Dashboard", ordinal: "01" },
  files: { label: "Storage", ordinal: "02" },
  inbox: { label: "Drop Point", ordinal: "04" },
  shared: { label: "Shared", ordinal: "05" },
  synchronization: { label: "Synchronization", ordinal: "06" },
  trash: { label: "Trash", ordinal: "07" },
  settings: { label: "Settings", ordinal: "08" },
};
const DEFAULT_NAVIGATION_ORDER: readonly PrimaryViewName[] = ["dashboard", "files", "inbox", "shared", "synchronization", "trash", "settings"];
const DEFAULT_DASHBOARD_ORDER: readonly DashboardCardName[] = ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"];
const DEFAULT_SETTINGS_ORDER: readonly SettingsCardName[] = ["appearance", "security", "backup", "gryphon", "updates", "logs"];
const SETTINGS_CARD_TITLES: Readonly<Record<SettingsCardName, string>> = {
  appearance: "Appearance",
  security: "Security",
  backup: "Backup",
  gryphon: "Bot connection",
  updates: "Updates",
  logs: "Logs",
};
const OWNER_ROUTE_PATHS: Readonly<Record<ViewName, string>> = {
  dashboard: "/dashboard",
  files: "/files",
  inbox: "/inbox",
  shared: "/shared",
  synchronization: "/synchronization",
  trash: "/trash",
  settings: "/settings",
  documentation: "/documentation",
};

function ownerRouteFromPathname(pathname: string): OwnerRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/") return { view: "dashboard", folderSegments: [] };
  for (const view of Object.keys(OWNER_ROUTE_PATHS) as ViewName[]) {
    const base = OWNER_ROUTE_PATHS[view];
    if (normalized === base) return { view, folderSegments: [] };
    if ((view === "files" || view === "inbox") && normalized.startsWith(`${base}/`)) {
      try {
        const folderSegments = normalized.slice(base.length + 1).split("/").map((segment) => decodeURIComponent(segment));
        return { view, folderSegments };
      } catch {
        return { view, folderSegments: [] };
      }
    }
  }
  return { view: "files", folderSegments: [] };
}

function ownerRouteUrl(route: OwnerRoute): string {
  const base = OWNER_ROUTE_PATHS[route.view];
  if ((route.view !== "files" && route.view !== "inbox") || route.folderSegments.length === 0) return base;
  return `${base}/${route.folderSegments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

const PROTECTED_ROOT_RESOURCE_IDS = new Set([
  DROP_POINT_RESOURCE_ID,
  LABORATORY_RESOURCE_ID,
  BACKUPS_RESOURCE_ID,
  MASTERMIND_RESOURCE_ID,
  SYNC_RESOURCE_ID,
  VOLT_RESOURCE_ID,
]);

const defaultPreferences: Omit<OwnerPreferences, "updatedAt"> = {
  accentColor: "#00a8ff",
  sidebarMode: "fixed",
  navigationOrder: DEFAULT_NAVIGATION_ORDER,
  dashboardOrder: DEFAULT_DASHBOARD_ORDER,
  settingsOrder: DEFAULT_SETTINGS_ORDER,
  trashRetentionDays: 30,
  uploadBufferGiB: 110,
  maximumUploadFileGiB: 20,
};

function ownerPreferences(value: OwnerPreferences | Omit<OwnerPreferences, "updatedAt">): Omit<OwnerPreferences, "updatedAt"> {
  const order = "navigationOrder" in value ? value.navigationOrder : undefined;
  const validOrder = Array.isArray(order)
    && order.length === DEFAULT_NAVIGATION_ORDER.length
    && new Set(order).size === order.length
    && order.every((item) => item in NAV_ITEMS);
  const dashboardOrder = "dashboardOrder" in value ? value.dashboardOrder : undefined;
  const dashboardDestinations = new Set<string>(DEFAULT_DASHBOARD_ORDER);
  const validDashboardOrder = Array.isArray(dashboardOrder)
    && dashboardOrder.length === DEFAULT_DASHBOARD_ORDER.length
    && new Set(dashboardOrder).size === dashboardOrder.length
    && dashboardOrder.every((item: unknown) => typeof item === "string" && dashboardDestinations.has(item));
  const settingsOrder = "settingsOrder" in value ? value.settingsOrder : undefined;
  const settingsDestinations = new Set<string>(DEFAULT_SETTINGS_ORDER);
  const knownSettingsOrder = Array.isArray(settingsOrder)
    && settingsOrder.length > 0
    && settingsOrder.length <= DEFAULT_SETTINGS_ORDER.length
    && new Set(settingsOrder).size === settingsOrder.length
    && settingsOrder.every((item: unknown) => typeof item === "string" && settingsDestinations.has(item));
  const validSettingsOrder = knownSettingsOrder
    && settingsOrder.length === DEFAULT_SETTINGS_ORDER.length
  const typedSettingsOrder = knownSettingsOrder ? settingsOrder as SettingsCardName[] : undefined;
  const normalizedSettingsOrder = typedSettingsOrder === undefined
    ? DEFAULT_SETTINGS_ORDER
    : [...typedSettingsOrder, ...DEFAULT_SETTINGS_ORDER.filter((item) => !typedSettingsOrder.includes(item))];
  const uploadBufferGiB = Number.isSafeInteger(value.uploadBufferGiB) && value.uploadBufferGiB >= 1 && value.uploadBufferGiB <= 8_192
    ? value.uploadBufferGiB
    : 110;
  const maximumUploadFileGiB = Number.isSafeInteger(value.maximumUploadFileGiB) && value.maximumUploadFileGiB >= 1 && value.maximumUploadFileGiB <= 4_096
    ? value.maximumUploadFileGiB
    : 20;
  const validUploadLimits = maximumUploadFileGiB * 10 <= uploadBufferGiB * 9;
  return {
    accentColor: value.accentColor,
    sidebarMode: "sidebarMode" in value && value.sidebarMode === "auto-hide" ? "auto-hide" : "fixed",
    navigationOrder: validOrder ? order as readonly PrimaryViewName[] : DEFAULT_NAVIGATION_ORDER,
    dashboardOrder: validDashboardOrder ? dashboardOrder as readonly DashboardCardName[] : DEFAULT_DASHBOARD_ORDER,
    settingsOrder: validSettingsOrder ? typedSettingsOrder ?? DEFAULT_SETTINGS_ORDER : normalizedSettingsOrder,
    trashRetentionDays: Number.isSafeInteger(value.trashRetentionDays) && value.trashRetentionDays >= 1 && value.trashRetentionDays <= 365
      ? value.trashRetentionDays
      : 30,
    uploadBufferGiB: validUploadLimits ? uploadBufferGiB : 110,
    maximumUploadFileGiB: validUploadLimits ? maximumUploadFileGiB : 20,
  };
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

function formatStorageBytes(bytes: number): string {
  return formatBytes(bytes).replace("KiB", "KB").replace("MiB", "MB").replace("GiB", "GB").replace("TiB", "TB");
}

function formatStorageDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = String(date.getDate()).padStart(2, "0");
  const month = months[date.getMonth()] ?? "—";
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${day} ${month} ${String(date.getFullYear())}, ${hour}:${minute}`;
}

function droppedPayload(dataTransfer: DataTransfer): { readonly files: readonly File[]; readonly directoryCount: number } {
  const items = [...dataTransfer.items];
  if (items.length === 0) return { files: [...dataTransfer.files], directoryCount: 0 };
  const files: File[] = [];
  let directoryCount = 0;
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory === true) { directoryCount += 1; continue; }
    const file = item.getAsFile();
    if (file === null) { directoryCount += 1; continue; }
    files.push(file);
  }
  return { files, directoryCount };
}

function dropContainsUploadableFiles(dataTransfer: DataTransfer): boolean {
  const items = [...dataTransfer.items];
  if (items.length === 0) return dataTransfer.files.length > 0;
  return items.some((item) => item.kind === "file" && item.webkitGetAsEntry()?.isDirectory !== true);
}

function skippedDirectoryMessage(directoryCount: number): string {
  return `${String(directoryCount)} ${directoryCount === 1 ? "folder was" : "folders were"} skipped. Open ${directoryCount === 1 ? "it" : "them"} and select the files inside.`;
}

function formatDropCountdown(expiresAt: string | undefined, now: number): string {
  if (expiresAt === undefined) return "—";
  const remainingSeconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1_000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatShareAccess(mode: ShareInfo["mode"]): string {
  if (mode === "view") return "View";
  if (mode === "download") return "Download";
  if (mode === "browse") return "Browse";
  return "Browse + download";
}

function compareResources(left: Resource, right: Resource, field: SortField, direction: SortDirection): number {
  const multiplier = direction === "ascending" ? 1 : -1;
  if (field === "name") return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) * multiplier;
  if (field === "modified") return (new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime()) * multiplier;
  return (left.sizeBytes - right.sizeBytes || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })) * multiplier;
}

function resourceExtension(resource: Resource): string {
  return resource.name.split(".").pop()?.toLocaleLowerCase() ?? "";
}

function resourceKind(resource: Resource): FileKind {
  if (resource.type === "folder") return "folder";
  const mime = resource.mimeType?.toLocaleLowerCase() ?? "";
  const extension = resourceExtension(resource);
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg"].includes(extension)) return "image";
  if (mime.startsWith("video/") || ["mp4", "webm", "mov", "m4v", "ogv"].includes(extension)) return "video";
  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "oga", "m4a", "flac"].includes(extension)) return "audio";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  if (mime === "text/markdown" || ["md", "markdown"].includes(extension)) return "markdown";
  if (["application/zip", "application/vnd.rar", "application/x-rar-compressed"].includes(mime) || ["zip", "rar"].includes(extension)) return "archive";
  if (mime.startsWith("text/") || ["txt", "log", "csv", "json", "yaml", "yml", "doc", "docx", "odt", "rtf"].includes(extension)) return "document";
  return "file";
}

function previewable(resource: Resource | undefined): resource is Resource {
  if (resource === undefined || resource.type !== "file") return false;
  const kind = resourceKind(resource);
  if (["image", "video", "audio", "pdf", "markdown"].includes(kind)) return true;
  const mime = resource.mimeType?.toLocaleLowerCase() ?? "";
  return kind === "document" && (mime.startsWith("text/") || ["application/json", "application/yaml", "application/octet-stream"].includes(mime))
    && ["txt", "log", "csv", "json", "yaml", "yml"].includes(resourceExtension(resource));
}

function FileKindIcon({ kind }: { readonly kind: FileKind }) {
  if (kind === "folder") return <svg viewBox="0 0 24 18" aria-hidden="true"><path d="M1 3.5h8l2-2h12v15H1z" /></svg>;
  if (kind === "image") return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1" y="1" width="18" height="18" /><circle cx="6" cy="6" r="2" /><path d="m2 17 5-6 3 3 3-4 5 7" /></svg>;
  if (kind === "video") return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1" y="3" width="18" height="14" /><path d="m8 7 6 3-6 3z" /></svg>;
  if (kind === "audio") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4v10a3 3 0 1 1-2-2.83V6l9-2v8a3 3 0 1 1-2-2.83V2z" /></svg>;
  if (kind === "archive") return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="1" width="14" height="18" /><path d="M8 1v3h4V1M8 7h4v3H8zm0 6h4v3H8z" /></svg>;
  return <svg viewBox="0 0 18 20" aria-hidden="true"><path d="M2 1h9l5 5v13H2z" /><path d="M11 1v5h5" />{kind === "pdf" ? <text x="4" y="15">PDF</text> : kind === "markdown" ? <text x="4" y="15">MD</text> : null}</svg>;
}

function ResourceVisual({ resource }: { readonly resource: Resource }) {
  const kind = resourceKind(resource);
  if (kind === "image") return <span className="resource-visual resource-visual--thumbnail"><img src={downloadUrl(resource.id, true)} alt="" loading="lazy" /></span>;
  if (kind === "video") return <span className="resource-visual resource-visual--thumbnail"><video src={downloadUrl(resource.id, true)} muted preload="metadata" aria-hidden="true" /></span>;
  return <span className={`resource-visual resource-visual--${kind}`}><FileKindIcon kind={kind} /></span>;
}

async function importPdfJs() {
  const module = await import("pdfjs-dist");
  module.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return module;
}

let pdfJsModulePromise: ReturnType<typeof importPdfJs> | undefined;

function loadPdfJs(): ReturnType<typeof importPdfJs> {
  pdfJsModulePromise ??= importPdfJs();
  return pdfJsModulePromise;
}

function PdfPreview({ resource }: { readonly resource: Resource }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pageViewport = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | undefined>();
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    setPage(1); setPages(1); setDocument(undefined); setError(""); setLoading(true);
    void loadPdfJs().then(({ getDocument }) => {
      task = getDocument({
        url: downloadUrl(resource.id, true),
        withCredentials: true,
        rangeChunkSize: 1024 * 1024,
      });
      return task.promise;
    }).then((loaded) => {
      if (!active) return;
      setDocument(loaded); setPages(loaded.numPages); setLoading(false);
    }).catch(() => { if (active) { setLoading(false); setError("PDF preview could not be loaded."); } });
    return () => { active = false; if (task !== undefined) void task.destroy(); };
  }, [resource.id]);

  useEffect(() => {
    const element = pageViewport.current;
    if (element === null) return;
    const update = () => setBounds((current) => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      return current.width === next.width && current.height === next.height ? current : next;
    });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (document === undefined || bounds.width <= 0 || bounds.height <= 0) return;
    let active = true;
    let renderTask: RenderTask | undefined;
    setRendering(true); setError("");
    void document.getPage(Math.min(page, document.numPages)).then(async (current) => {
      if (!active || canvas.current === null) return;
      const natural = current.getViewport({ scale: 1 });
      const fitScale = Math.max(0.1, Math.min(
        Math.max(1, bounds.width - 32) / natural.width,
        Math.max(1, bounds.height - 32) / natural.height,
      ));
      const cssScale = fitScale * zoom;
      const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const viewport = current.getViewport({ scale: cssScale * outputScale });
      const context = canvas.current.getContext("2d");
      if (context === null) throw new Error("Canvas is unavailable");
      canvas.current.width = Math.ceil(viewport.width);
      canvas.current.height = Math.ceil(viewport.height);
      canvas.current.style.width = `${String(Math.ceil(viewport.width / outputScale))}px`;
      canvas.current.style.height = `${String(Math.ceil(viewport.height / outputScale))}px`;
      renderTask = current.render({ canvas: canvas.current, canvasContext: context, viewport });
      await renderTask.promise;
      current.cleanup();
      setRendering(false);
    }).catch(() => { if (active) { setRendering(false); setError("PDF page could not be rendered."); } });
    return () => { active = false; renderTask?.cancel(); };
  }, [bounds.height, bounds.width, document, page, zoom]);

  return <div className="quick-preview__pdf">
    <div className="quick-preview__pdf-page" ref={pageViewport}>
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p role="status">Loading PDF…</p> : null}
      <canvas ref={canvas} aria-label={`PDF page ${String(page)} of ${String(pages)}`} hidden={loading || error !== ""} />
    </div>
    <div className="quick-preview__controls"><button type="button" disabled={loading || rendering || page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>{String(page)} / {String(pages)}</span><button type="button" disabled={loading || rendering || page >= pages} onClick={() => setPage((value) => value + 1)}>Next</button><button type="button" aria-label="Zoom out" disabled={loading || rendering || zoom <= .5} onClick={() => setZoom((value) => Math.max(.5, value - .25))}>−</button><span>{String(Math.round(zoom * 100))}%</span><button type="button" aria-label="Zoom in" disabled={loading || rendering || zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + .25))}>+</button></div>
  </div>;
}

function MarkdownPreview({ resource }: { readonly resource: Resource }) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setHtml(""); setError(""); setLoading(true);
    void fetch(downloadUrl(resource.id, true), { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("preview_failed");
        const text = await response.text();
        return DOMPurify.sanitize(await marked.parse(text, { async: true }));
      })
      .then((value) => { setHtml(value); setLoading(false); })
      .catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) { setLoading(false); setError("Markdown preview could not be rendered."); } });
    return () => controller.abort();
  }, [resource.id]);
  if (error) return <p role="alert">{error}</p>;
  if (loading) return <p role="status">Loading Markdown…</p>;
  return <article className="quick-preview__markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function QuickPreview({ resource, onClose }: { readonly resource: Resource; readonly onClose: () => void }) {
  const kind = resourceKind(resource);
  return <div className="quick-preview" role="dialog" aria-modal="true" aria-label={`Preview ${resource.name}`} onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <header><strong>{resource.name}</strong><span>{formatBytes(resource.sizeBytes)}</span><a href={downloadUrl(resource.id)}>Download</a><button type="button" onClick={onClose} aria-label="Close preview">×</button></header>
    <div className={`quick-preview__content quick-preview__content--${kind}`}>
      {kind === "image" ? <img src={downloadUrl(resource.id, true)} alt={resource.name} />
        : kind === "video" ? <video src={downloadUrl(resource.id, true)} controls autoPlay />
          : kind === "audio" ? <div className="quick-preview__audio"><FileKindIcon kind="audio" /><audio src={downloadUrl(resource.id, true)} controls autoPlay /></div>
            : kind === "pdf" ? <PdfPreview resource={resource} />
              : kind === "markdown" ? <MarkdownPreview resource={resource} />
                : <iframe title={`Preview of ${resource.name}`} src={downloadUrl(resource.id, true)} sandbox="allow-same-origin" />}
    </div>
  </div>;
}

function SortButton({ field, activeField, direction, children, onChange }: {
  readonly field: SortField;
  readonly activeField: SortField;
  readonly direction: SortDirection;
  readonly children: ReactNode;
  readonly onChange: (field: SortField) => void;
}) {
  const active = field === activeField;
  return <button className={`sort-button ${active ? "sort-button--active" : ""}`} type="button" onClick={() => onChange(field)} aria-sort={active ? direction : "none"}>{children}<span aria-hidden="true">{active ? direction === "ascending" ? "↑" : "↓" : "↕"}</span></button>;
}

function ResourceContextMenu({ state, canPaste, canCompress, canExtract, protectedRoot, onAction, onClose }: {
  readonly state: ContextMenuState;
  readonly canPaste: boolean;
  readonly canCompress: boolean;
  readonly canExtract: boolean;
  readonly protectedRoot: boolean;
  readonly onAction: (action: ContextAction) => void;
  readonly onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const actions = [
    { id: "copy", label: "Copy", disabled: state.resource === undefined },
    { id: "cut", label: "Cut", disabled: state.resource === undefined || protectedRoot },
    { id: "paste", label: "Paste", disabled: !canPaste },
    { id: "download", label: "Download", disabled: state.resource === undefined },
    { id: "folder", label: "New folder", disabled: false },
    { id: "trash", label: "Delete", disabled: state.resource === undefined || protectedRoot, danger: true },
    { id: "rename", label: "Rename", disabled: state.resource === undefined },
    { id: "share", label: "Share", disabled: state.resource === undefined },
    { id: "extract", label: "Extract here", disabled: !canExtract },
    { id: "compress", label: "Compress to ZIP", disabled: !canCompress },
  ] as const;
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [onClose]);
  const keyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : (index <= 0 ? buttons.length : index) - 1;
    buttons[next]?.focus();
  };
  const width = 155;
  const height = actions.length * 25;
  const x = Math.max(8, Math.min(state.x, window.innerWidth - width - 8));
  const y = Math.max(8, Math.min(state.y, window.innerHeight - height - 8));
  return <div ref={menu} className="context-menu" role="menu" aria-label={state.resource === undefined ? "Folder actions" : `Actions for ${state.resource.name}`} style={{ left: x, top: y }} onKeyDown={keyboard} onPointerDown={(event) => event.stopPropagation()}>
    {actions.map((action, index) => <button className={"danger" in action ? "context-menu__danger" : ""} type="button" role="menuitem" key={action.id} disabled={action.disabled} onClick={() => onAction(action.id)}><span className="context-menu__ordinal" aria-hidden="true">{String(index + 1)}.</span><span>{action.label}</span></button>)}
  </div>;
}

function useGatewayHealth(): GatewayHealth {
  const [state, setState] = useState<GatewayHealth>({ gateway: "checking", storage: "checking" });
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch("/health/ready", { credentials: "same-origin", cache: "no-store" });
        const body = await response.json() as HealthResponse;
        if (active) {
          const gateway = response.ok && body.status === "ok" ? "ready" : "degraded";
          const storageCheck = (body as Partial<HealthResponse>).checks?.storage;
          const storage = storageCheck === undefined
            ? gateway
            : storageCheck.state === "pass"
              ? "ready"
              : storageCheck.state === "fail"
                ? "degraded"
                : "degraded";
          setState({ gateway, storage });
        }
      } catch {
        if (active) setState({ gateway: "degraded", storage: "degraded" });
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return state;
}

function LoginView({ health, onAuthenticated }: { readonly health: GatewayState; readonly onAuthenticated: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const accessKeyInput = useRef<HTMLInputElement>(null);
  const clearAccessKey = () => {
    if (accessKeyInput.current !== null) accessKeyInput.current.value = "";
  };
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const accessKey = accessKeyInput.current?.value ?? "";
    if (!accessKey || pending) return;
    let refocusAccessKey = false;
    setPending(true);
    setError("");
    try {
      await api.login(accessKey);
      clearAccessKey();
      onAuthenticated();
    } catch (caught) {
      clearAccessKey();
      setError(caught instanceof ApiError && caught.status === 429
        ? "Too many attempts. Wait before trying again."
        : "The access key was not accepted.");
      refocusAccessKey = true;
    } finally {
      setPending(false);
      if (refocusAccessKey) window.requestAnimationFrame(() => accessKeyInput.current?.focus());
    }
  };
  const reachabilityLabel = health === "checking"
    ? "Checking Reachability"
    : health === "ready"
      ? "Service Reachability"
      : "Service Unreachable";
  const reachabilityDescription = health === "checking" ? "checking" : health === "ready" ? "reachable" : "unreachable";
  return (
    <main className="login-view">
      <div className="login-composition">
        <header className="login-brand" aria-labelledby="login-title">
          <h1 id="login-title" className="wordmark" aria-label="Saturn">saturn</h1>
          <span className="login-brand__icon" aria-hidden="true"><img src={saturnPlanet} alt="" /></span>
        </header>
        <section className="login-panel" aria-labelledby="login-title">
          <div
            className={`login-reachability login-reachability--${health}`}
            role="status"
            aria-live="polite"
            aria-label={`Service reachability: ${reachabilityDescription}`}
          >
            <span>{reachabilityLabel}</span>
            <span className="login-reachability__square" aria-hidden="true" />
          </div>
          <form className="login-form" onSubmit={(event) => void submit(event)}>
            <p id="login-error" className="login-error" role="alert">{error}</p>
            <label className="login-key-field" htmlFor="owner-access-key">
              <span className="sr-only">Access Key</span>
              <input
                ref={accessKeyInput}
                id="owner-access-key"
                name="owner-access-key"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={512}
                placeholder="Access Key..."
                aria-describedby="login-error"
                aria-invalid={error ? "true" : undefined}
                disabled={pending}
                required
              />
            </label>
            <button className="button login-submit" type="submit" disabled={pending}>
              {pending ? "Authenticating…" : "Enter service"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function Dialog({ title, description, children, onClose, dismissible = true }: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly dismissible?: boolean;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  const drag = useRef<{ readonly x: number; readonly y: number; readonly left: number; readonly top: number } | undefined>(undefined);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    const focusable = node?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])");
    focusable?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) { event.preventDefault(); close.current(); return; }
      if (event.key !== "Tab" || node === null) return;
      const items = [...node.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])")];
      if (items.length === 0) { event.preventDefault(); node.focus(); return; }
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => { window.removeEventListener("keydown", handleKey); previousFocus.current?.focus(); };
  }, [dismissible]);
  const moveDialog = (event: ReactPointerEvent<HTMLElement>) => {
    const start = drag.current; const node = dialog.current;
    if (start === undefined || node === null) return;
    const dx = event.clientX - start.x; const dy = event.clientY - start.y;
    const width = node.offsetWidth; const height = node.offsetHeight;
    const desiredLeft = Math.min(Math.max(8, start.left + dx), Math.max(8, window.innerWidth - width - 8));
    const desiredTop = Math.min(Math.max(8, start.top + dy), Math.max(8, window.innerHeight - height - 8));
    const centeredLeft = (window.innerWidth - width) / 2; const centeredTop = (window.innerHeight - height) / 2;
    setOffset({ x: desiredLeft - centeredLeft, y: desiredTop - centeredTop });
  };
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (dismissible && event.target === event.currentTarget) onClose(); }}>
      <section ref={dialog} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} style={{ transform: `translate(${String(offset.x)}px, ${String(offset.y)}px)` }}>
        <header
          className="dialog__head"
          onPointerDown={(event) => { if ((event.target as HTMLElement).closest("button") !== null || dialog.current === null) return; const box = dialog.current.getBoundingClientRect(); drag.current = { x: event.clientX, y: event.clientY, left: box.left, top: box.top }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={moveDialog}
          onPointerUp={(event) => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        >
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog" disabled={!dismissible}>×</button>
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

function DropReachability({ state }: { readonly state: GatewayState }) {
  const label = state === "checking" ? "Checking" : state === "ready" ? "Available" : "Unavailable";
  return <div className={`drop-reachability drop-reachability--${state}`} role="status" aria-live="polite" aria-label={`Service Reachability: ${label}`}>
    <span>Service Reachability</span><i aria-hidden="true" />
  </div>;
}

const DROP_CHANNEL_HISTORY_KEY = "saturnDropChannelId";

function expectedDropChannelId(): string | undefined {
  const value: unknown = window.history.state;
  if (typeof value !== "object" || value === null || !(DROP_CHANNEL_HISTORY_KEY in value)) return undefined;
  const channelId = (value as Record<string, unknown>)[DROP_CHANNEL_HISTORY_KEY];
  return typeof channelId === "string" ? channelId : undefined;
}

function rememberDropChannel(channelId: string): void {
  const current = typeof window.history.state === "object" && window.history.state !== null ? window.history.state as Record<string, unknown> : {};
  window.history.replaceState({ ...current, [DROP_CHANNEL_HISTORY_KEY]: channelId }, "", window.location.href);
}

function DropView({ health }: { readonly health: GatewayState }) {
  const [state, setState] = useState<"checking" | "redeem" | "active">("checking");
  const [session, setSession] = useState<DropSessionInfo | undefined>();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [jobs, setJobs] = useState<Array<{ readonly id: string; readonly name: string; readonly progress: number; readonly state: DropUploadStatus["state"] }>>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    const expectedChannelId = expectedDropChannelId();
    void dropApi.session().then(async (value) => {
      if (expectedChannelId !== undefined && value.channelId !== expectedChannelId) {
        setJobs([]); setSession(undefined); setMessage("This tab's Drop session has expired. Enter a code to open another channel."); setState("redeem");
        return;
      }
      rememberDropChannel(value.channelId);
      setSession(value); setState("active");
      const uploads = await dropApi.uploads().catch(() => []);
      setJobs(uploads.map((upload) => ({ id: upload.id, name: upload.filename ?? "Upload", progress: upload.expectedSize === 0 ? 1 : upload.receivedSize / upload.expectedSize, state: upload.state })));
    }).catch(() => { setJobs([]); setSession(undefined); if (expectedChannelId !== undefined) setMessage("This Drop session has expired. Enter a code to continue."); setState("redeem"); });
  }, []);
  useEffect(() => {
    if (state !== "active") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state]);
  const expired = session !== undefined && new Date(session.expiresAt).getTime() <= now;
  const dropBlocked = pending || expired || session?.buffer?.state === "refusing";
  useEffect(() => {
    if (state !== "active" || expired) return;
    const applyUploads = (uploads: readonly DropUploadStatus[]) => setJobs((current) => uploads.map((upload) => ({ id: upload.id, name: upload.filename ?? current.find((job) => job.id === upload.id)?.name ?? "Upload", progress: upload.expectedSize === 0 ? 1 : upload.receivedSize / upload.expectedSize, state: upload.state })));
    const unsubscribe = dropApi.subscribeUploads(applyUploads);
    if (unsubscribe !== undefined) return unsubscribe;
    const poll = window.setInterval(() => { void dropApi.uploads().then(applyUploads).catch(() => undefined); }, 1_500);
    return () => window.clearInterval(poll);
  }, [state, expired]);

  const redeem = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!code || pending) return; setPending(true); setMessage("");
    try { const value = await dropApi.redeem(code); rememberDropChannel(value.channelId); setCode(""); setSession(value); setState("active"); }
    catch (error) { setCode(""); setMessage(error instanceof ApiError && error.status === 429 ? "Too many attempts. Wait before trying again." : "The Drop code was not accepted."); }
    finally { setPending(false); }
  };

  const upload = async (files: readonly File[], initialMessage = "") => {
    if (files.length === 0 || pending || expired) return;
    setPending(true); setMessage(initialMessage);
    for (const file of files) {
      const localId = crypto.randomUUID();
      setJobs((current) => [...current, { id: localId, name: file.name, progress: 0, state: "uploading" }]);
      try {
        const result = await uploadDropFile(file, (progress) => setJobs((current) => current.map((job) => job.id === localId ? { ...job, progress } : job)));
        setJobs((current) => current.map((job) => job.id === localId ? { id: result.id, name: file.name, progress: 1, state: result.state } : job));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) { setState("redeem"); setSession(undefined); }
        setJobs((current) => current.map((job) => job.id === localId ? { ...job, state: "failed" } : job));
        setMessage("An upload stopped before entering the verified buffer. No partial file is visible in Drop Point.");
      }
    }
    setPending(false); if (input.current !== null) input.current.value = "";
  };

  const acceptDrop = (dataTransfer: DataTransfer) => {
    const dropped = droppedPayload(dataTransfer);
    const directoryMessage = dropped.directoryCount > 0 ? skippedDirectoryMessage(dropped.directoryCount) : "";
    if (dropped.files.length > 0) void upload(dropped.files, directoryMessage);
    else if (directoryMessage) setMessage(directoryMessage);
  };

  const cancel = async (id: string) => {
    setPending(true);
    try { const value = await dropApi.cancel(id); setJobs((current) => current.map((job) => job.id === id ? { ...job, state: value.state } : job)); }
    catch { setMessage("This upload can no longer be removed because remote transfer has started."); }
    finally { setPending(false); }
  };

  if (state === "checking") return <main className="boot-state">Checking Drop session…</main>;
  return (
    <main
      className={`drop-view drop-view--${state === "redeem" ? "closed" : "opened"}`}
      onDragEnter={(event) => { if (state !== "active" || !event.dataTransfer.types.includes("Files")) return; event.preventDefault(); dragDepth.current += 1; setDraggingFiles(true); }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDraggingFiles(false); }}
      onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = state === "active" && !dropBlocked && dropContainsUploadableFiles(event.dataTransfer) ? "copy" : "none"; }}
      onDrop={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); dragDepth.current = 0; setDraggingFiles(false); if (state === "active" && !dropBlocked) acceptDrop(event.dataTransfer); }}
    >
      {state === "redeem" ? <div className="drop-closed-composition">
        <form className="drop-code-gate" aria-labelledby="drop-code-title" onSubmit={(event) => void redeem(event)}>
          <p id="drop-code-title">Please enter<br />drop point code:</p>
          <label className="sr-only" htmlFor="drop-code">Drop code</label>
          <input id="drop-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} autoComplete="one-time-code" inputMode="text" maxLength={9} placeholder="Code..." required autoFocus />
          <button className="drop-code-submit" type="submit" disabled={pending}>{pending ? "Checking..." : "Enter"}</button>
          <p className="drop-code-error" role="alert">{message}</p>
        </form>
        <DropReachability state={health} />
      </div> : <div className="drop-opened-composition">
        <h1 id="drop-title" className="drop-public-title">saturn drop point</h1>
        <section className="drop-opened-panel" aria-labelledby="drop-title">
          <div className="drop-public-notice"><strong>Upload only Gateway</strong><p>This page cannot list Saturn contents. Files uploaded through this Drop code appear here on every connected device.</p></div>
          <div className={`drop-session-status ${expired ? "drop-session-status--expired" : ""}`}><span>Drop code status:</span><strong>{formatDropCountdown(session?.expiresAt, now)}</strong></div>
          <DropReachability state={health} />
          <div className={`drop-upload-stage ${jobs.length > 0 ? "drop-upload-stage--with-jobs" : ""}`}>
            <button className="drop-target" type="button" disabled={dropBlocked} onClick={() => input.current?.click()}>
              <span>Drop and drag files here</span><small>or choose files - up to {formatStorageBytes(session?.maxFileBytes ?? session?.maxBytes ?? 0)}</small>
            </button>
            <input ref={input} aria-label="Choose files for Drop" className="visually-hidden-input" type="file" multiple onChange={(event) => void upload([...event.target.files ?? []])} />
            {jobs.length === 0 ? null : <div className="drop-jobs" role="region" aria-live="polite" aria-label="Shared Drop upload queue">
              {jobs.map((job) => <div className={`drop-job ${job.state === "stored" ? "drop-job--stored" : ""}`} key={job.id}><span>{job.name}</span><progress max={1} value={job.progress} /><strong>{job.state}</strong>{!expired && ["reserved", "uploading", "buffered"].includes(job.state) ? <button type="button" onClick={() => void cancel(job.id)} disabled={pending}>Remove</button> : null}</div>)}
            </div>}
          </div>
          {session?.buffer === undefined || session.buffer.state === "available" ? null : <p className={`buffer-state buffer-state--${session.buffer.state}`}>Local buffer {session.buffer.state.toUpperCase()} · {formatBytes(session.buffer.reservedBytes)} reserved of {formatBytes(session.buffer.maxBytes)}</p>}
          {message ? <p className="drop-message" role="alert">{message}</p> : null}
        </section>
      </div>}
      {draggingFiles ? <div className={`storage-drop-overlay ${dropBlocked ? "storage-drop-overlay--blocked" : ""}`} aria-hidden="true"><strong>{dropBlocked ? "UPLOAD UNAVAILABLE" : "UPLOAD HERE"}</strong><span>Drop Point</span></div> : null}
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

function FilesView({ initialFolderId, title, routeSegments, onPathChange, shareCapabilities, onShareCapabilityCreated, onShareCapabilityRevoked, addNotice, onUnauthorized, embeddedInHouse = false, refreshKey = 0 }: {
  readonly initialFolderId: string;
  readonly title: string;
  readonly routeSegments: readonly string[];
  readonly onPathChange: (segments: readonly string[], replace?: boolean) => void;
  readonly shareCapabilities: Readonly<Record<string, string>>;
  readonly onShareCapabilityCreated: (id: string, url: string) => void;
  readonly onShareCapabilityRevoked: (id: string) => void;
  readonly addNotice: (kind: Notice["kind"], message: string) => void;
  readonly onUnauthorized: () => void;
  readonly embeddedInHouse?: boolean;
  readonly refreshKey?: number;
}) {
  const [folderId, setFolderId] = useState(initialFolderId);
  const [folder, setFolder] = useState<Resource | undefined>();
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ readonly id: string; readonly name: string; readonly segments: readonly string[] }>>([]);
  const [items, setItems] = useState<readonly Resource[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ readonly field: SortField; readonly direction: SortDirection }>({ field: "name", direction: "ascending" });
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
  const [pathError, setPathError] = useState("");
  const [clipboard, setClipboard] = useState<ResourceClipboard | undefined>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | undefined>();
  const [shares, setShares] = useState<readonly ShareInfo[]>([]);
  const [shareResource, setShareResource] = useState<Resource | undefined>();
  const [shareMode, setShareMode] = useState<ShareInfo["mode"]>("download");
  const [shareExpiresAt, setShareExpiresAt] = useState("");
  const [sharePassword, setSharePassword] = useState("");
  const [shareError, setShareError] = useState("");
  const [shareDetails, setShareDetails] = useState<ShareInfo | undefined>();
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [archiveName, setArchiveName] = useState("");
  const [archiveJobs, setArchiveJobs] = useState<readonly ArchiveJobInfo[]>([]);
  const dragDepth = useRef(0);
  const archiveStates = useRef(new Map<string, ArchiveJobInfo["state"]>());
  const selectionAnchor = useRef<string | undefined>(undefined);
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
      selectionAnchor.current = undefined;
      setPathError("");
    } catch (error) {
      handleError(error, "The folder could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  const loadShares = async () => {
    try { const value = await api.shares(); setShares(Array.isArray(value) ? value : []); }
    catch (error) { handleError(error, "Share status could not be loaded."); }
  };

  const routeKey = JSON.stringify(routeSegments);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPathError("");
    setSelected(new Set());
    selectionAnchor.current = undefined;
    void (async () => {
      try {
        const chain = await api.resolveFolder(initialFolderId, routeSegments);
        const current = chain.at(-1);
        if (current === undefined) throw new Error("Folder path could not be resolved");
        const [children, currentShares] = await Promise.all([api.children(current.id), api.shares()]);
        if (controller.signal.aborted) return;
        const canonicalSegments = chain.slice(1).map((resource) => resource.name);
        setFolderId(current.id);
        setFolder(current);
        setItems(children);
        setShares(Array.isArray(currentShares) ? currentShares : []);
        setBreadcrumbs(chain.slice(0, -1).map((resource, index) => ({
          id: resource.id,
          name: index === 0 ? initialFolderId === ROOT_RESOURCE_ID ? "root" : title.toLocaleLowerCase() : resource.name,
          segments: canonicalSegments.slice(0, index),
        })));
        if (canonicalSegments.some((segment, index) => segment !== routeSegments[index])) onPathChange(canonicalSegments, true);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFolder(undefined);
        setItems([]);
        setBreadcrumbs([]);
        const message = error instanceof ApiError && error.status === 404
          ? "The folder in this URL does not exist."
          : "The folder path could not be loaded.";
        setPathError(message);
        handleError(error, message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [initialFolderId, routeKey, refreshKey]);

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = query ? items.filter((item) => item.name.toLocaleLowerCase().includes(query)) : items;
    return [...filtered].sort((left, right) => compareResources(left, right, sort.field, sort.direction));
  }, [items, search, sort]);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const single = selectedItems.length === 1 ? selectedItems[0] : undefined;
  const visibleSizeBytes = visible.reduce((total, item) => total + item.sizeBytes, 0);
  const atStorageRoot = folderId === ROOT_RESOURCE_ID;
  const folderUnavailable = folder === undefined;
  const selectedProtectedRoot = selectedItems.some((item) => PROTECTED_ROOT_RESOURCE_IDS.has(item.id));
  const singleProtectedRoot = single !== undefined && PROTECTED_ROOT_RESOURCE_IDS.has(single.id);
  const activeShareByResource = useMemo(() => new Map(shares.filter((share) => share.state === "active").map((share) => [share.resourceId, share])), [shares]);
  const activeArchiveJobs = archiveJobs.filter((job) => !["completed", "failed", "cancelled"].includes(job.state));

  useEffect(() => {
    let active = true;
    archiveStates.current.clear();
    const poll = async () => {
      try {
        const jobs = await api.archiveJobs(folderId);
        if (!active) return;
        let refreshFolder = false;
        for (const job of jobs) {
          const previous = archiveStates.current.get(job.id);
          if (previous !== undefined && previous !== "completed" && job.state === "completed") {
            refreshFolder = true;
            addNotice("success", `${job.outputName} is ready.`);
          }
          if (previous !== undefined && !["failed", "cancelled"].includes(previous) && job.state === "failed") {
            addNotice("error", `${job.outputName} failed: ${job.failureCode ?? "archive processing failed"}.`);
          }
          archiveStates.current.set(job.id, job.state);
        }
        setArchiveJobs(jobs);
        if (refreshFolder) setItems(await api.children(folderId));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) onUnauthorized();
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [folderId]);

  useEffect(() => {
    const keyboard = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null) return;
      if (event.key === "Escape" && preview !== undefined) { event.preventDefault(); setPreview(undefined); return; }
      if (event.code !== "Space") return;
      if (preview !== undefined) { event.preventDefault(); setPreview(undefined); return; }
      if (previewable(single)) { event.preventDefault(); setPreview(single); }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [preview, single]);

  const changeSort = (field: SortField) => setSort((current) => current.field === field
    ? { field, direction: current.direction === "ascending" ? "descending" : "ascending" }
    : { field, direction: field === "name" ? "ascending" : "descending" });

  const selectOnly = (resource: Resource) => {
    selectionAnchor.current = resource.id;
    setSelected(new Set([resource.id]));
  };

  const selectResource = (resource: Resource, additive: boolean, range: boolean) => {
    if (range) {
      const anchorIndex = visible.findIndex((item) => item.id === selectionAnchor.current);
      const resourceIndex = visible.findIndex((item) => item.id === resource.id);
      setSelected((current) => {
        if (anchorIndex < 0 || resourceIndex < 0) return new Set([resource.id]);
        const next = additive ? new Set(current) : new Set<string>();
        const start = Math.min(anchorIndex, resourceIndex);
        const end = Math.max(anchorIndex, resourceIndex);
        for (const item of visible.slice(start, end + 1)) next.add(item.id);
        return next;
      });
      if (anchorIndex < 0) selectionAnchor.current = resource.id;
      return;
    }

    selectionAnchor.current = resource.id;
    setSelected((current) => {
      if (!additive) return new Set([resource.id]);
      const next = new Set(current);
      if (next.has(resource.id)) next.delete(resource.id); else next.add(resource.id);
      return next;
    });
  };

  const openContextMenu = (event: ReactMouseEvent, resource?: Resource) => {
    event.preventDefault();
    if (resource !== undefined && !selected.has(resource.id)) selectOnly(resource);
    setContextMenu({ x: event.clientX, y: event.clientY, ...(resource === undefined ? {} : { resource }) });
  };

  const openFolder = (resource: Resource) => {
    if (resource.type !== "folder") return;
    onPathChange([...routeSegments, resource.name]);
  };

  const navigateBreadcrumb = (index: number) => {
    const target = breadcrumbs[index];
    if (target === undefined) return;
    onPathChange(target.segments);
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

  const pasteClipboard = async (targetFolderId = folderId) => {
    if (clipboard === undefined || pending) return;
    setPending(true);
    try {
      if (clipboard.operation === "copy") await api.copy(clipboard.resource.id, targetFolderId);
      else await api.move(clipboard.resource.id, targetFolderId);
      addNotice("success", `${clipboard.resource.name} ${clipboard.operation === "copy" ? "copied" : "moved"} here.`);
      if (clipboard.operation === "cut") setClipboard(undefined);
      await reload();
    } catch (error) { handleError(error, "Paste could not be completed. Check for a name conflict or protected root."); }
    finally { setPending(false); }
  };

  const beginShare = (resource: Resource) => {
    setShareResource(resource);
    setShareMode(resource.type === "folder" ? "browse" : "download");
    setShareExpiresAt("");
    setSharePassword("");
    setShareError("");
  };

  const closeShareComposer = () => {
    setShareResource(undefined);
    setSharePassword("");
    setShareError("");
  };

  const createShare = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (shareResource === undefined || pending) return;
    setPending(true);
    setShareError("");
    try {
      const created = await api.createShare({
        resourceId: shareResource.id,
        mode: shareMode,
        ...(shareExpiresAt ? { expiresAt: new Date(shareExpiresAt).toISOString() } : {}),
        ...(sharePassword ? { password: sharePassword } : {}),
      });
      onShareCapabilityCreated(created.share.id, created.url);
      closeShareComposer();
      setShareDetails(created.share);
      await loadShares();
      addNotice("success", "Share created. Its capability remains available in Shared for this session.");
    } catch (error) {
      if (error instanceof ApiError && error.code === "share_denied") {
        setShareError("This resource cannot be shared in its current state or security classification.");
      } else if (error instanceof ApiError && error.code === "invalid_request") {
        setShareError("Check the expiry date and use at least 12 characters when a password is enabled.");
      } else {
        handleError(error, "The share could not be created.");
      }
    }
    finally { setPending(false); }
  };

  const revokeShare = async (share: ShareInfo) => {
    if (pending) return;
    setPending(true);
    try {
      const revoked = await api.revokeShare(share.id);
      setShareDetails(revoked);
      onShareCapabilityRevoked(share.id);
      await loadShares();
      addNotice("success", "Share revoked immediately.");
    } catch (error) { handleError(error, "The share could not be revoked."); }
    finally { setPending(false); }
  };

  const copyText = async (value: string) => {
    try { await navigator.clipboard.writeText(value); addNotice("success", "Share link copied."); }
    catch { addNotice("error", "Clipboard access was blocked. Select and copy the visible link manually."); }
  };

  const extractArchive = async (resource: Resource) => {
    if (pending) return;
    setPending(true);
    try {
      const job = await api.extractArchive(resource.id);
      archiveStates.current.set(job.id, job.state);
      setArchiveJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      addNotice("info", `${resource.name} queued for extraction.`);
    } catch (error) { handleError(error, "The archive could not be queued for extraction."); }
    finally { setPending(false); }
  };

  const createArchive = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || selectedItems.length === 0 || atStorageRoot) return;
    setPending(true);
    try {
      const job = await api.createArchive(folderId, selectedItems.map((item) => item.id), archiveName);
      archiveStates.current.set(job.id, job.state);
      setArchiveJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setArchiveName("");
      addNotice("info", `${job.outputName} queued for creation.`);
    } catch (error) { handleError(error, "The ZIP archive could not be queued."); }
    finally { setPending(false); }
  };

  const contextAction = (action: ContextAction) => {
    const resource = contextMenu?.resource;
    setContextMenu(undefined);
    if (action === "paste") { void pasteClipboard(resource?.type === "folder" ? resource.id : folderId); return; }
    if (action === "folder") { setForm("folder"); setFormName(""); return; }
    if (action === "compress") {
      const suggested = selectedItems.length === 1 ? selectedItems[0]?.name.replace(/\.(zip|rar)$/i, "") ?? "archive" : "archive";
      setArchiveName(`${suggested}.zip`);
      return;
    }
    if (resource === undefined) return;
    if (action === "extract") { void extractArchive(resource); return; }
    if (action === "copy" || action === "cut") { setClipboard({ operation: action, resource }); addNotice("info", `${resource.name} ready to ${action}.`); return; }
    if (action === "download") { window.location.assign(resource.type === "file" ? downloadUrl(resource.id) : folderDownloadUrl(resource.id)); return; }
    if (action === "trash") { selectOnly(resource); setConfirmTrash(true); return; }
    if (action === "rename") { selectOnly(resource); setForm("rename"); setFormName(resource.name); return; }
    beginShare(resource);
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

  const drop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (folderUnavailable) return;
    if (atStorageRoot) {
      addNotice("error", "Create or open a folder first. Files cannot be stored directly in the Saturn root.");
      return;
    }
    const dropped = droppedPayload(event.dataTransfer);
    if (dropped.directoryCount > 0) addNotice("info", skippedDirectoryMessage(dropped.directoryCount));
    if (dropped.files.length > 0) void performUpload(dropped.files);
  };

  return (
    <section className={`workspace storage-workspace ${embeddedInHouse ? "storage-workspace--in-house" : ""} ${draggingFiles ? "storage-workspace--drop" : ""}`} aria-labelledby={embeddedInHouse ? undefined : "workspace-title"} aria-label={embeddedInHouse ? "Drop Point storage" : undefined} onDragEnter={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); dragDepth.current += 1; setDraggingFiles(true); }} onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDraggingFiles(false); }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = atStorageRoot || !dropContainsUploadableFiles(event.dataTransfer) ? "none" : "copy"; } }} onDrop={drop}>
      {embeddedInHouse ? null : <header className="workspace__head">
        <div>
          <p className="eyebrow">Owner workspace</p>
          <h1 id="workspace-title" className="page-title">{title}</h1>
        </div>
        {uploadProgress === undefined ? null : <div className="upload-progress" role="status">Uploading {Math.round(uploadProgress * 100)}%</div>}
      </header>}
      <div className="storage-browserbar">
        <div className="storage-path-summary">
          <nav className="breadcrumbs" aria-label="Folder breadcrumbs">
            {embeddedInHouse ? <><span className="breadcrumbs__boundary">root</span><span className="breadcrumbs__separator" aria-hidden="true">›</span></> : null}
            {breadcrumbs.map((item, index) => <button type="button" key={`${item.id}-${String(index)}`} onClick={() => navigateBreadcrumb(index)}>{item.name}</button>)}
            <span>{folder?.id === initialFolderId ? initialFolderId === ROOT_RESOURCE_ID ? "root" : title.toLocaleLowerCase() : folder?.name ?? routeSegments.at(-1) ?? title}</span>
          </nav>
          <p className="storage-meta" aria-live="polite">{String(visible.length)} items · {String(selectedItems.length)} selected · {formatStorageBytes(visibleSizeBytes)}{embeddedInHouse && uploadProgress !== undefined ? ` · uploading ${String(Math.round(uploadProgress * 100))}%` : ""}</p>
        </div>
        <label className="search-control storage-search">
          <span className="sr-only">Search storage</span>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" />
        </label>
        {embeddedInHouse ? null : <button className="button storage-upload" type="button" onClick={() => uploadInput.current?.click()} disabled={pending || atStorageRoot || folderUnavailable || loading}>Upload here</button>}
        <input ref={uploadInput} aria-label="Choose files to upload" className="visually-hidden-input" type="file" multiple onChange={(event) => void performUpload([...event.target.files ?? []])} />
      </div>
      <div className="selection-bar storage-selection-bar" role="toolbar" aria-label="Selection actions">
        <span>{clipboard === undefined ? selectedItems.length === 0 ? "No selection" : `${String(selectedItems.length)} selected` : `${clipboard.operation === "copy" ? "Copy" : "Cut"}: ${clipboard.resource.name}`}</span>
        <button type="button" disabled={single === undefined} onClick={() => { if (single?.type === "folder") openFolder(single); }}>Open</button>
        <button type="button" disabled={single === undefined} onClick={() => { if (single !== undefined) window.location.assign(single.type === "file" ? downloadUrl(single.id) : folderDownloadUrl(single.id)); }}>Download</button>
        <button type="button" disabled={!previewable(single)} onClick={() => { if (previewable(single)) setPreview(single); }}>Preview</button>
        <button type="button" disabled={single?.type !== "file"} onClick={() => { if (single !== undefined) void showVersions(single); }}>Versions</button>
        <button type="button" disabled={single?.type !== "file" || pending} onClick={() => overwriteInput.current?.click()}>Overwrite</button>
        <input ref={overwriteInput} aria-label="Choose replacement file" className="visually-hidden-input" type="file" onChange={(event) => { if (single !== undefined) void performUpload([...event.target.files ?? []], single); }} />
        <button type="button" disabled={single === undefined} onClick={() => { if (single !== undefined) { setForm("rename"); setFormName(single.name); } }}>Rename</button>
        <button type="button" disabled={single === undefined || singleProtectedRoot} onClick={() => { if (single !== undefined) { setForm("move"); setDestinationId(folderId); setFormName(single.name); } }}>Move</button>
        <button type="button" disabled={single === undefined} onClick={() => { if (single !== undefined) { setForm("copy"); setDestinationId(folderId); setFormName(single.name); } }}>Copy</button>
        <button type="button" disabled={clipboard === undefined || pending} onClick={() => void pasteClipboard()}>Paste</button>
        <button type="button" disabled={single === undefined} onClick={() => { if (single !== undefined) beginShare(single); }}>Share</button>
        <button className="danger-link" type="button" disabled={selectedItems.length === 0 || selectedProtectedRoot} onClick={() => setConfirmTrash(true)}>Trash</button>
      </div>
      <div className="collection storage-collection" tabIndex={0} onContextMenu={(event) => openContextMenu(event)} onKeyDown={(event) => { if (event.key === "Delete" && selectedItems.length > 0 && !selectedProtectedRoot) setConfirmTrash(true); }}>
        <div className="file-row file-row--head storage-file-row">
          <SortButton field="name" activeField={sort.field} direction={sort.direction} onChange={changeSort}>Name</SortButton>
          <SortButton field="modified" activeField={sort.field} direction={sort.direction} onChange={changeSort}>Modified</SortButton>
          <SortButton field="size" activeField={sort.field} direction={sort.direction} onChange={changeSort}>Size</SortButton>
          <span>Shared status</span>
        </div>
        {loading ? <p className="empty-state">Loading folder…</p> : pathError ? <p className="empty-state" role="alert">{pathError}</p> : visible.length === 0 ? <p className="empty-state">{atStorageRoot ? "No root folders are available. Create one to get started." : "No matching items. Drop files here or create a folder."}</p> : visible.map((item) => (
          <div className={`file-row storage-file-row ${item.type === "folder" ? "file-row--folder" : ""} ${selected.has(item.id) ? "file-row--selected" : ""}`} key={item.id} onClick={(event) => { if ((event.target as HTMLElement).closest("button, input") === null) selectResource(item, event.ctrlKey || event.metaKey, event.shiftKey); }} onContextMenu={(event) => { event.stopPropagation(); openContextMenu(event, item); }} onDoubleClick={() => item.type === "folder" ? openFolder(item) : previewable(item) ? setPreview(item) : undefined} onKeyDown={(event) => { if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") { const bounds = event.currentTarget.getBoundingClientRect(); setContextMenu({ x: bounds.left + 40, y: bounds.top + 30, resource: item }); } }}>
            <input
              className="file-row__selector"
              type="checkbox"
              aria-label={`Select ${item.name}`}
              checked={selected.has(item.id)}
              readOnly
              onClick={(event) => selectResource(item, true, event.shiftKey)}
            />
            <button className="file-name" type="button" onClick={(event) => selectResource(item, event.ctrlKey || event.metaKey, event.shiftKey)}>
              <ResourceVisual resource={item} /><span className="file-name__label">{item.name}</span>
            </button>
            <time dateTime={item.updatedAt}>{formatStorageDate(item.updatedAt)}</time>
            <span>{item.type === "folder" && item.sizeBytes === 0 ? "—" : formatStorageBytes(item.sizeBytes)}</span>
            {activeShareByResource.get(item.id) === undefined ? <span className="share-status share-status--private">Private</span> : <button className="share-status share-status--active" type="button" onClick={() => setShareDetails(activeShareByResource.get(item.id))}>[ Shared ]</button>}
          </div>
        ))}
      </div>
      {activeArchiveJobs.length === 0 ? null : <div className="storage-archive-jobs" role="status">{activeArchiveJobs.map((job) => <span key={job.id}>{job.kind === "extract" ? "Extracting" : "Compressing"} {job.outputName} · {job.state}</span>)}</div>}
      <p className="drop-hint">{atStorageRoot ? "Create arbitrary folders here, then open one to upload files. Preinstalled folders can be renamed but not moved or deleted." : "Drag and drop files anywhere in this workspace to upload into the current folder."}</p>
      {draggingFiles ? <div className={`storage-drop-overlay ${atStorageRoot ? "storage-drop-overlay--blocked" : ""}`} aria-hidden="true"><strong>{atStorageRoot ? "OPEN A FOLDER" : "UPLOAD HERE"}</strong><span>{atStorageRoot ? "Files cannot be stored directly in root" : folder?.name ?? title}</span></div> : null}

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
      {archiveName === "" ? null : <Dialog title="Compress to ZIP" description={`${String(selectedItems.length)} selected item(s) will be archived by a background worker.`} onClose={() => setArchiveName("")}><form className="dialog-form" onSubmit={(event) => void createArchive(event)}><label>Archive name<input value={archiveName} onChange={(event) => setArchiveName(event.target.value)} required maxLength={255} autoComplete="off" autoFocus /></label><div className="dialog__actions"><button className="button" type="button" onClick={() => setArchiveName("")}>Cancel</button><button className="button button--primary" type="submit" disabled={pending || atStorageRoot}>Create ZIP</button></div></form></Dialog>}
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
      {preview === undefined ? null : <QuickPreview resource={preview} onClose={() => setPreview(undefined)} />}
      {contextMenu === undefined ? null : <ResourceContextMenu state={contextMenu} canPaste={clipboard !== undefined} canCompress={selectedItems.length > 0 && !atStorageRoot} canExtract={contextMenu.resource !== undefined && resourceKind(contextMenu.resource) === "archive"} protectedRoot={contextMenu.resource !== undefined && PROTECTED_ROOT_RESOURCE_IDS.has(contextMenu.resource.id)} onAction={contextAction} onClose={() => setContextMenu(undefined)} />}
      {shareResource === undefined ? null : <Dialog title={`Share — ${shareResource.name}`} description="Create a read-only capability. Expiry and password are optional." onClose={closeShareComposer}><form className="dialog-form" onSubmit={(event) => void createShare(event)}>
        <label>Access<select value={shareMode} onChange={(event) => setShareMode(event.target.value as ShareInfo["mode"])}>{shareResource.type === "file" ? <><option value="view">View</option><option value="download">Download</option></> : <><option value="browse">Browse</option><option value="download_folder">Browse + download all</option></>}</select></label>
        <label>Expires<input type="datetime-local" value={shareExpiresAt} min={new Date().toISOString().slice(0, 16)} onChange={(event) => setShareExpiresAt(event.target.value)} /></label>
        <label>Password<input type="password" value={sharePassword} minLength={12} maxLength={128} onChange={(event) => setSharePassword(event.target.value)} autoComplete="new-password" placeholder="Off" /></label>
        {shareError ? <p className="form-error" role="alert">{shareError}</p> : null}
        <div className="dialog__actions"><button className="button" type="button" onClick={closeShareComposer}>Cancel</button><button className="button button--primary" type="submit" disabled={pending}>Create share</button></div>
      </form></Dialog>}
      {shareDetails === undefined ? null : <Dialog title="Share" description={shareDetails.resourceName} onClose={() => setShareDetails(undefined)}><div className="share-details">
        {shareCapabilities[shareDetails.id] === undefined ? <p className="muted">This historical link cannot be copied because Saturn stores only its non-reversible hash. You can still revoke access.</p> : <div className="share-link-field"><input aria-label="Share link" value={shareCapabilities[shareDetails.id]} readOnly /><button className="button" type="button" onClick={() => void copyText(shareCapabilities[shareDetails.id] ?? "")}>Copy</button></div>}
        <dl><div><dt>Access</dt><dd>{shareDetails.mode.replace("_", " ")}</dd></div><div><dt>Expires</dt><dd>{shareDetails.expiresAt === undefined ? "None" : new Date(shareDetails.expiresAt).toLocaleString()}</dd></div><div><dt>Password</dt><dd>{shareDetails.locked ? "On" : "Off"}</dd></div><div><dt>Status</dt><dd>{shareDetails.state}</dd></div></dl>
        <div className="dialog__actions"><button className="button button--danger" type="button" disabled={pending || shareDetails.state !== "active"} onClick={() => void revokeShare(shareDetails)}>Revoke</button></div>
      </div></Dialog>}
    </section>
  );
}

function InternalDropUploader({ health, addNotice, onUnauthorized, onStored }: { readonly health: GatewayState; readonly addNotice: (kind: Notice["kind"], message: string) => void; readonly onUnauthorized: () => void; readonly onStored: () => void }) {
  const [jobs, setJobs] = useState<Array<{ readonly id: string; readonly name: string; readonly progress: number; readonly state: DropUploadStatus["state"] }>>([]);
  const [session, setSession] = useState<DropSessionInfo | undefined>();
  const [pending, setPending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sessionExpiresAt = useRef(0);
  const dragDepth = useRef(0);
  const monitor = async (id: string) => {
    for (;;) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      try {
        const status = await dropApi.status(id);
        setJobs((current) => current.map((job) => job.id === id ? { ...job, progress: status.expectedSize === 0 ? 1 : status.receivedSize / status.expectedSize, state: status.state } : job));
        if (status.state === "stored") onStored();
        if (["stored", "failed", "cancelled"].includes(status.state)) return;
      } catch { return; }
    }
  };
  const upload = async (files: readonly File[]) => {
    if (files.length === 0 || pending) return;
    setPending(true);
    try {
      if (sessionExpiresAt.current <= Date.now() + 5_000) {
        const openedSession = await api.openInternalDropSession();
        sessionExpiresAt.current = new Date(openedSession.expiresAt).getTime();
        setSession(openedSession);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else addNotice("error", "The in-house Drop buffer could not be opened.");
      setPending(false);
      return;
    }
    for (const file of files) {
      const id = crypto.randomUUID();
      setJobs((current) => [...current, { id, name: file.name, progress: 0, state: "uploading" }]);
      try {
        const result = await uploadDropFile(file, (progress) => setJobs((current) => current.map((job) => job.id === id ? { ...job, progress } : job)));
        setJobs((current) => current.map((job) => job.id === id ? { id: result.id, name: file.name, progress: 1, state: result.state } : job));
        if (result.state === "stored") onStored();
        if (!["stored", "failed", "cancelled"].includes(result.state)) void monitor(result.id);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) onUnauthorized();
        setJobs((current) => current.map((job) => job.id === id ? { ...job, state: "failed" } : job));
      }
    }
    setPending(false);
    if (input.current !== null) input.current.value = "";
    addNotice("success", "Files entered the in-house Drop buffer.");
  };
  const acceptDrop = (dataTransfer: DataTransfer) => {
    const dropped = droppedPayload(dataTransfer);
    if (dropped.directoryCount > 0) addNotice("info", skippedDirectoryMessage(dropped.directoryCount));
    if (dropped.files.length > 0) void upload(dropped.files);
  };
  return <aside className={`internal-drop ${dragging ? "internal-drop--dragging" : ""}`} aria-labelledby="internal-drop-title" onDragEnter={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.stopPropagation(); dragDepth.current += 1; setDragging(true); }} onDragLeave={(event) => { event.stopPropagation(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = dropContainsUploadableFiles(event.dataTransfer) ? "copy" : "none"; } }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false); acceptDrop(event.dataTransfer); }}>
    <h2 id="internal-drop-title" className="internal-drop__title">saturn drop point</h2>
    <div className="drop-public-notice"><strong>Upload only Gateway</strong><p>This page cannot list Saturn contents. Only files selected in this session appear here.</p></div>
    <div className="drop-session-status"><span>Drop code status:</span><strong>none</strong></div>
    <DropReachability state={health} />
    <div className={`drop-upload-stage ${jobs.length > 0 ? "drop-upload-stage--with-jobs" : ""}`}>
      <button className="drop-target" type="button" disabled={pending} onClick={() => input.current?.click()}><span>{dragging ? "Release to upload" : "Drop and drag files here"}</span><small>or choose files - up to {formatStorageBytes(session?.maxFileBytes ?? session?.maxBytes ?? 20 * 1024 ** 3).replace(".0 ", " ")}</small></button>
      <input ref={input} className="visually-hidden-input" type="file" multiple aria-label="Choose files for in-house Drop" onChange={(event) => void upload([...event.target.files ?? []])} />
      {jobs.length === 0 ? null : <div className="drop-jobs" role="region" aria-live="polite" aria-label="In-house upload queue">{jobs.map((job) => <div className={`drop-job ${job.state === "stored" ? "drop-job--stored" : ""}`} key={job.id}><span>{job.name}</span><progress max={1} value={job.progress} /><strong>{job.state}</strong></div>)}</div>}
    </div>
  </aside>;
}

function InHouseDropView({ health, routeSegments, onPathChange, shareCapabilities, onShareCapabilityCreated, onShareCapabilityRevoked, addNotice, onUnauthorized }: {
  readonly health: GatewayState;
  readonly routeSegments: readonly string[];
  readonly onPathChange: (segments: readonly string[], replace?: boolean) => void;
  readonly shareCapabilities: Readonly<Record<string, string>>;
  readonly onShareCapabilityCreated: (id: string, url: string) => void;
  readonly onShareCapabilityRevoked: (id: string) => void;
  readonly addNotice: (kind: Notice["kind"], message: string) => void;
  readonly onUnauthorized: () => void;
}) {
  const [storageRevision, setStorageRevision] = useState(0);
  return <section className="workspace in-house-drop" aria-labelledby="in-house-drop-title">
    <header className="workspace__head"><h1 id="in-house-drop-title" className="page-title">drop point</h1></header>
    <div className="in-house-drop__body">
      <FilesView embeddedInHouse refreshKey={storageRevision} initialFolderId={DROP_POINT_RESOURCE_ID} title="Drop Point" routeSegments={routeSegments} onPathChange={onPathChange} shareCapabilities={shareCapabilities} onShareCapabilityCreated={onShareCapabilityCreated} onShareCapabilityRevoked={onShareCapabilityRevoked} addNotice={addNotice} onUnauthorized={onUnauthorized} />
      <InternalDropUploader health={health} addNotice={addNotice} onUnauthorized={onUnauthorized} onStored={() => setStorageRevision((current) => current + 1)} />
    </div>
  </section>;
}

function TrashView({ retentionDays, addNotice, onUnauthorized }: { readonly retentionDays: number; readonly addNotice: (kind: Notice["kind"], message: string) => void; readonly onUnauthorized: () => void }) {
  const [items, setItems] = useState<readonly Resource[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | undefined>();
  const [restoreCandidate, setRestoreCandidate] = useState<Resource | undefined>();
  const [purgeCandidate, setPurgeCandidate] = useState<Resource | undefined>();
  const [sort, setSort] = useState<{ readonly field: SortField; readonly direction: SortDirection }>({ field: "modified", direction: "descending" });
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try { setItems(await api.trash()); } catch (error) { if (error instanceof ApiError && error.status === 401) onUnauthorized(); else addNotice("error", "Trash could not be loaded."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return items
      .filter((item) => [item.name, item.trashedFromName ?? "", item.storagePath, item.type].some((value) => value.toLocaleLowerCase().includes(query)))
      .sort((left, right) => compareResources(left, right, sort.field, sort.direction));
  }, [items, search, sort]);
  const visibleSizeBytes = visible.reduce((total, item) => total + item.sizeBytes, 0);
  const changeSort = (field: SortField) => setSort((current) => current.field === field
    ? { field, direction: current.direction === "ascending" ? "descending" : "ascending" }
    : { field, direction: field === "name" ? "ascending" : "descending" });
  const restore = async () => {
    if (restoreCandidate === undefined) return;
    const candidate = restoreCandidate;
    setPending(true);
    try {
      await api.restoreResource(candidate.id);
      setItems((current) => current.filter((item) => item.id !== candidate.id));
      setExpanded((current) => current === candidate.id ? undefined : current);
      setRestoreCandidate(undefined);
      addNotice("success", `${candidate.trashedFromName ?? candidate.name} restored to its original folder.`);
      await load();
    }
    catch (error) { if (error instanceof ApiError && error.status === 401) onUnauthorized(); else addNotice("error", "Restore failed; no bytes were discarded."); }
    finally { setPending(false); }
  };
  const purge = async () => {
    if (purgeCandidate === undefined) return;
    const candidate = purgeCandidate;
    setPending(true);
    try {
      await api.purgeTrashResource(candidate.id);
      setItems((current) => current.filter((item) => item.id !== candidate.id));
      setExpanded((current) => current === candidate.id ? undefined : current);
      setPurgeCandidate(undefined);
      addNotice("success", `${candidate.trashedFromName ?? candidate.name} permanently deleted.`);
      await load();
    }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else if (error instanceof ApiError && (error.status === 409 || error.status === 423)) {
        setPurgeCandidate(undefined);
        addNotice("info", "Permanent deletion is already running. Saturn will remove the item from Trash when it completes.");
        window.setTimeout(() => { void load(); }, 2_000);
      }
      else addNotice("error", "Permanent deletion failed. Saturn will safely retry the recorded operation on the next request.");
    }
    finally { setPending(false); }
  };
  return (
    <section className="workspace trash-workspace" aria-labelledby="trash-title">
      <header className="workspace__head"><h1 className="page-title" id="trash-title">trash</h1></header>
      <div className="trash-workspace__body">
        <div className="trash-command-bar">
          <div className="trash-path-summary"><span>reversible trash</span><p className="storage-meta" aria-live="polite">{String(visible.length)} items · {formatStorageBytes(visibleSizeBytes)} · {String(retentionDays)}-day retention</p></div>
          <label className="search-control storage-search trash-search">
            <span className="sr-only">Search trash</span>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" />
          </label>
        </div>
        <div className="trash-owner-list">
          <div className="trash-owner-list__head">
            <SortButton field="name" activeField={sort.field} direction={sort.direction} onChange={changeSort}>Name</SortButton>
            <SortButton field="modified" activeField={sort.field} direction={sort.direction} onChange={changeSort}>Deleted</SortButton>
            <SortButton field="size" activeField={sort.field} direction={sort.direction} onChange={changeSort}>Size</SortButton>
            <span>Retention</span><span aria-hidden="true" />
          </div>
          <div className="trash-owner-list__body">
            {loading ? <p className="empty-state">Loading trash…</p> : visible.length === 0 ? <p className="empty-state">{search.trim() ? "No matching trash records." : "Trash is empty."}</p> : visible.map((item) => {
              const isExpanded = expanded === item.id;
              const displayName = item.trashedFromName ?? item.name;
              return <article className={`trash-owner-row ${isExpanded ? "trash-owner-row--expanded" : ""}`} key={item.id}>
                <div className="trash-owner-row__summary">
                  <button className="trash-owner-row__toggle" type="button" aria-expanded={isExpanded} onClick={() => setExpanded((current) => current === item.id ? undefined : item.id)}>
                    <strong className={`trash-owner-row__name ${item.type === "folder" ? "trash-owner-row__name--folder" : ""}`}>{displayName}</strong>
                    <time dateTime={item.updatedAt}>{formatStorageDate(item.updatedAt)}</time>
                    <span>{item.type === "folder" && item.sizeBytes === 0 ? "—" : formatStorageBytes(item.sizeBytes)}</span>
                    <span>{item.purgeAfter === undefined ? "Manual" : formatStorageDate(item.purgeAfter)}</span>
                  </button>
                  <div className="trash-owner-row__actions">
                    <button className="trash-owner-row__restore" type="button" disabled={pending} onClick={() => setRestoreCandidate(item)}>Restore</button>
                    <button className="trash-owner-row__purge" type="button" disabled={pending} onClick={() => setPurgeCandidate(item)}>Delete permanently</button>
                  </div>
                </div>
                {isExpanded ? <div className="trash-owner-row__details"><dl>
                  <div><dt>Type</dt><dd>{item.type}</dd></div>
                  <div><dt>Deleted at</dt><dd>{formatStorageDate(item.updatedAt)}</dd></div>
                  <div><dt>Purge at</dt><dd>{item.purgeAfter === undefined ? "Manual" : formatStorageDate(item.purgeAfter)}</dd></div>
                  <div><dt>Original name</dt><dd>{displayName}</dd></div>
                  <div><dt>Original folder ID</dt><dd>{item.trashedFromParentId ?? "Unavailable"}</dd></div>
                  <div><dt>Status</dt><dd className="state-danger">{item.status}</dd></div>
                </dl><p>{item.type === "file" ? "Restore returns this file to its original folder. Permanent deletion destroys its stored bytes and retained versions after explicit confirmation." : "Restore returns this folder to its original location. Permanent deletion recursively destroys every file, subfolder and retained version after explicit confirmation."}</p></div> : null}
              </article>;
            })}
          </div>
        </div>
      </div>
      {restoreCandidate === undefined ? null : <ConfirmDialog title={`Restore ${restoreCandidate.trashedFromName ?? restoreCandidate.name}`} description="The item returns to its original folder and keeps the same stable resource ID. Restore stops if the original name is occupied." confirmLabel="Restore" pending={pending} onConfirm={() => void restore()} onClose={() => setRestoreCandidate(undefined)} />}
      {purgeCandidate === undefined ? null : <ConfirmDialog title={`Delete ${purgeCandidate.trashedFromName ?? purgeCandidate.name} permanently`} description={purgeCandidate.type === "folder" ? "This recursively destroys every stored file, subfolder and retained version in the folder. Nothing in this folder can be restored after this action." : "This permanently destroys the stored file bytes and every retained version. The file cannot be restored after this action."} confirmLabel="Delete permanently" danger pending={pending} onConfirm={() => void purge()} onClose={() => setPurgeCandidate(undefined)} />}
    </section>
  );
}

function SharedView({ shareCapabilities, onShareCapabilityRevoked, addNotice, onAnonymous }: {
  readonly shareCapabilities: Readonly<Record<string, string>>;
  readonly onShareCapabilityRevoked: (id: string) => void;
  readonly addNotice: (kind: Notice["kind"], message: string) => void;
  readonly onAnonymous: () => void;
}) {
  const [shares, setShares] = useState<readonly ShareInfo[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ readonly field: SortField; readonly direction: SortDirection }>({ field: "modified", direction: "descending" });
  const [expanded, setExpanded] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const load = async () => {
    try { const value = await api.shares(); setShares(value.filter((share) => share.state === "active")); }
    catch (error) { if (error instanceof ApiError && error.status === 401) onAnonymous(); else addNotice("error", "Shares could not be loaded."); }
  };
  useEffect(() => { void load(); }, []);
  const revoke = async (share: ShareInfo) => {
    if (pending) return;
    setPending(true);
    try {
      await api.revokeShare(share.id);
      setShares((current) => current.filter((item) => item.id !== share.id));
      setExpanded((current) => current === share.id ? undefined : current);
      onShareCapabilityRevoked(share.id);
      addNotice("success", "Share revoked immediately.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onAnonymous();
      } else {
        addNotice("error", "The share could not be revoked.");
      }
    }
    finally { setPending(false); }
  };
  const copyLink = async (id: string) => {
    const value = shareCapabilities[id];
    if (value === undefined) { addNotice("info", "This historical capability is non-recoverable. Reissue is awaiting the operator policy decision."); return; }
    try { await navigator.clipboard.writeText(value); addNotice("success", "Share link copied."); }
    catch { addNotice("error", "Clipboard access was blocked. Copy the visible link manually."); }
  };
  const changeSort = (field: SortField) => setSort((current) => current.field === field
    ? { field, direction: current.direction === "ascending" ? "descending" : "ascending" }
    : { field, direction: field === "name" ? "ascending" : "descending" });
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const multiplier = sort.direction === "ascending" ? 1 : -1;
    return [...shares]
      .filter((share) => [share.resourceName, share.resourceType, share.mode, share.state, share.id, share.resourceId, share.createdAt, share.updatedAt]
        .some((value) => value.toLocaleLowerCase().includes(query)))
      .sort((left, right) => sort.field === "name"
        ? left.resourceName.localeCompare(right.resourceName, undefined, { numeric: true, sensitivity: "base" }) * multiplier
        : (new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime()) * multiplier);
  }, [shares, search, sort]);
  return (
    <section className="workspace shared-workspace" aria-labelledby="shared-title">
      <header className="workspace__head"><h1 className="page-title" id="shared-title">shared</h1></header>
      <div className="shared-workspace__body">
        <div className="shared-command-bar" role="search" aria-label="Shared collection controls">
          <label className="shared-search-control">
            <span aria-hidden="true">⌕</span>
            <span className="sr-only">Search shared objects</span>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" aria-label="Search shared objects" />
          </label>
          <output className="sr-only" aria-live="polite">{String(visible.length)} of {String(shares.length)} shared objects</output>
        </div>
        <div className="share-owner-list">
          <div className="share-owner-list__head">
            <SortButton field="name" activeField={sort.field} direction={sort.direction} onChange={changeSort}>Name</SortButton>
            <SortButton field="modified" activeField={sort.field} direction={sort.direction} onChange={changeSort}>Modified</SortButton>
            <span>Access</span>
            <span aria-hidden="true" />
          </div>
          <div className="share-owner-list__body">
            {visible.length === 0 ? <p className="empty-state">No matching share records.</p> : visible.map((share) => {
              const capability = shareCapabilities[share.id];
              const isExpanded = expanded === share.id;
              return <article className={`share-owner-row ${isExpanded ? "share-owner-row--expanded" : ""}`} key={share.id}>
                <div className="share-owner-row__summary">
                  <button className="share-owner-row__toggle" type="button" aria-expanded={isExpanded} onClick={() => setExpanded((current) => current === share.id ? undefined : share.id)}>
                    <strong className={`share-owner-row__name ${share.resourceType === "folder" ? "share-owner-row__name--folder" : ""}`}>{share.resourceName}</strong>
                    <time dateTime={share.updatedAt}>{formatStorageDate(share.updatedAt)}</time>
                  </button>
                  <span className="share-owner-row__access">{formatShareAccess(share.mode)}</span>
                  <button className="share-owner-row__copy" type="button" disabled={share.state !== "active" || capability === undefined} title={capability === undefined ? "Historical capability is not recoverable from its stored hash" : "Copy capability URL"} onClick={() => void copyLink(share.id)}>Copy link</button>
                </div>
                {isExpanded ? <div className="share-owner-row__details">
                  <dl>
                    <div><dt>Password</dt><dd>{share.locked ? "On" : "Off"}</dd></div>
                    <div><dt>Shared since</dt><dd>{new Date(share.createdAt).toLocaleString()}</dd></div>
                    <div><dt>Expires at</dt><dd>{share.expiresAt === undefined ? "None" : new Date(share.expiresAt).toLocaleString()}</dd></div>
                    <div><dt>Size</dt><dd>{share.resourceType === "folder" && share.resourceSize === 0 ? "—" : formatBytes(share.resourceSize)}</dd></div>
                    <div><dt>Access</dt><dd>{formatShareAccess(share.mode)}</dd></div>
                    <div><dt>Downloads</dt><dd>{String(share.downloadCount)}{share.maxDownloads === undefined ? "" : ` / ${String(share.maxDownloads)}`}</dd></div>
                  </dl>
                  {capability === undefined ? <p className="muted">This historical link cannot be copied because Saturn stores only its non-reversible hash. You can still revoke access.</p> : <input aria-label={`Share URL for ${share.resourceName}`} value={capability} readOnly />}
                  <button className="button button--danger" type="button" onClick={() => void revoke(share)} disabled={pending || share.state !== "active"}>Revoke</button>
                </div> : null}
              </article>;
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function PublicShareReachability({ state }: { readonly state: GatewayState }) {
  const label = state === "checking" ? "Checking" : state === "ready" ? "Available" : "Unavailable";
  return <div className={`share-public-reachability share-public-reachability--${state}`} role="status" aria-label={`Service Reachability: ${label}`}>
    <span>Service Reachability</span><i aria-hidden="true" />
  </div>;
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
  const [unavailable, setUnavailable] = useState(false);
  const [sort, setSort] = useState<{ readonly field: "name" | "size"; readonly direction: SortDirection }>({ field: "name", direction: "ascending" });
  const loadChildren = async (parentId?: string) => { setChildren(await publicShareApi.children(token, parentId)); setFolderId(parentId); };
  useEffect(() => {
    void publicShareApi.metadata(token).then((value) => { setShare(value); setUnavailable(false); if (!value.locked && value.resourceType === "folder") void loadChildren(); }).catch(() => { setUnavailable(true); setMessage("This share is unavailable."); });
  }, [token]);
  const unlock = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); setPending(true); setMessage("");
    try { const value = await publicShareApi.unlock(token, password); setPassword(""); setShare(value); if (value.resourceType === "folder") await loadChildren(); }
    catch (error) { setPassword(""); setMessage(error instanceof ApiError && error.status === 429 ? "Too many attempts. Try later." : "The share password was not accepted."); }
    finally { setPending(false); }
  };
  const openFolder = async (id: string) => { setPending(true); try { setHistory((current) => [...current, folderId ?? ""]); await loadChildren(id); } catch { setMessage("That folder is outside this share."); } finally { setPending(false); } };
  const back = async () => { const next = history.at(-1); if (next === undefined) return; setHistory((current) => current.slice(0, -1)); await loadChildren(next || undefined); };
  const prepareAndDownload = async () => {
    setPending(true);
    setMessage("");
    try {
      const value = await publicShareApi.preparePackage(token);
      if (value.state !== "ready") throw new Error("Share package is not ready");
      const download = document.createElement("a");
      download.href = publicShareApi.packageUrl(token);
      download.download = `${share?.resourceName ?? "shared-folder"}.zip`;
      download.hidden = true;
      document.body.append(download);
      download.click();
      download.remove();
    } catch {
      setMessage("The folder package could not be prepared within its limits.");
    } finally {
      setPending(false);
    }
  };
  const entries = useMemo<readonly ShareChild[]>(() => {
    const source: readonly ShareChild[] = share !== undefined && !share.locked && share.resourceType === "file"
      ? [{ id: share.resourceId, type: "file", name: share.resourceName, sizeBytes: share.resourceSize, ...(share.resourceMimeType === undefined ? {} : { mimeType: share.resourceMimeType }), updatedAt: share.updatedAt }]
      : children;
    const multiplier = sort.direction === "ascending" ? 1 : -1;
    return [...source].sort((left, right) => {
      const value = sort.field === "name" ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) : left.sizeBytes - right.sizeBytes;
      return (value === 0 ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) : value) * multiplier;
    });
  }, [children, share, sort]);
  const changeSort = (field: SortField) => {
    if (field === "modified") return;
    setSort((current) => current.field === field
      ? { field, direction: current.direction === "ascending" ? "descending" : "ascending" }
      : { field, direction: "ascending" });
  };
  const knownTotal = share?.resourceType === "file" ? share.resourceSize : children.reduce((sum, child) => sum + child.sizeBytes, 0);
  const expiry = share?.expiresAt === undefined ? "none" : new Date(share.expiresAt).toLocaleString();
  const modeLabel = share?.mode === "view" ? "View only Gateway" : share?.mode === "browse" ? "Browse Gateway" : "Download only Gateway";
  const bulkSize = share?.resourceSize ?? knownTotal;
  return (
    <main className={`share-public-view ${share?.locked === true ? "share-public-view--locked" : "share-public-view--opened"}`}>
      {share === undefined ? unavailable ? <div className="not-found-state"><strong>404</strong><span>Shared link not found</span></div> : <p className="share-public-loading">{message || "Checking share…"}</p> : share.locked ? <div className="share-locked-composition">
        <form className="share-password-gate" aria-labelledby="shared-password-title" onSubmit={(event) => void unlock(event)}>
          <p id="shared-password-title">Please enter<br />shared link password:</p>
          <label className="sr-only" htmlFor="shared-link-password">Shared link password</label>
          <input id="shared-link-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="Password..." required autoFocus />
          <button className="share-password-submit" type="submit" disabled={pending}>{pending ? "Checking..." : "Enter"}</button>
          <p className="share-password-error" role="alert">{message}</p>
        </form>
        <PublicShareReachability state={health.gateway} />
      </div> : <div className="share-opened-composition">
        <h1 id="public-share-title" className="share-public-title">saturn shared link</h1>
        <section className="share-public-panel" aria-labelledby="public-share-title">
          <div className="share-public-notice"><strong>{modeLabel}</strong><p>Any content delivered to a browser can still be copied. Saturn does not promise impossible download prevention.{share.mode === "browse" ? " Download permission is not granted for this link." : ""}</p></div>
          <div className="share-public-facts"><span>Shared link expires:</span><strong>{expiry}</strong></div>
          <PublicShareReachability state={health.gateway} />
          <div className="share-public-files">
            <div className="share-public-files__title"><span>Files list:</span>{history.length > 0 ? <button type="button" onClick={() => void back()} disabled={pending}>← Back</button> : null}</div>
            <div className="share-browser" role="table" aria-label={`Shared files in ${share.resourceName}`}>
              <div className="share-browser__head" role="row">
                <span role="columnheader"><SortButton field="name" activeField={sort.field} direction={sort.direction} onChange={changeSort}>Name</SortButton></span>
                <span role="columnheader"><SortButton field="size" activeField={sort.field} direction={sort.direction} onChange={changeSort}>Size</SortButton></span>
                <span className="sr-only" role="columnheader">Action</span>
              </div>
              {entries.length === 0 ? <p className="share-browser__empty">This shared folder is empty.</p> : entries.map((child) => <div className="share-browser__row" role="row" key={child.id}>
                <span role="cell">{child.type === "folder" ? <button className="share-browser__name share-browser__name--folder" type="button" onClick={() => void openFolder(child.id)} disabled={pending}>{child.name}</button> : <span className="share-browser__name share-browser__name--file">{child.name}</span>}</span>
                <span role="cell">{formatBytes(child.sizeBytes)}</span>
                <span role="cell">{child.type === "file" && share.mode !== "browse" ? <a className="share-browser__download" aria-label={`${share.mode === "view" ? "Open" : "Download"} ${child.name}`} href={share.resourceType === "file" ? publicShareApi.contentUrl(token) : publicShareApi.contentUrl(token, child.id)}>{share.mode === "view" ? "↗" : "↓"}</a> : null}</span>
              </div>)}
            </div>
          </div>
          {share.resourceType === "file" ? <a className="share-public-download-all" href={publicShareApi.contentUrl(token)}>{share.mode === "view" ? "Open file" : "Download all"} - {formatBytes(share.resourceSize)}</a> : share.mode === "download_folder" ? <button className="share-public-download-all" type="button" onClick={() => void prepareAndDownload()} disabled={pending}>{pending ? "Preparing..." : `Download all - ${formatBytes(bulkSize)}`}</button> : share.mode === "browse" ? <button className="share-public-download-all" type="button" disabled>{`Download all - ${formatBytes(bulkSize)}`}</button> : null}
          <p className="share-public-error" role="alert">{message}</p>
        </section>
      </div>}
    </main>
  );
}

function CardHandle({ label, draggable, onKeyDown, onDragStart, onDragEnd }: {
  readonly label: string;
  readonly draggable: boolean;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onDragStart?: ((event: DragEvent<HTMLButtonElement>) => void) | undefined;
  readonly onDragEnd?: (() => void) | undefined;
}) {
  return <button className="card-handle" type="button" draggable={draggable} aria-label={label} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="Drag card · Alt+↑/↓" onKeyDown={onKeyDown} onDragStart={onDragStart} onDragEnd={onDragEnd}><span aria-hidden="true"><i /><i /><i /><i /></span></button>;
}

function UniversalCard({ ordinal, title, className = "", style, children, draggable = false, handleLabel, onHandleKeyDown, onDragStart, onDragOver, onDrop, onDragEnd }: {
  readonly ordinal: number;
  readonly title?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly children: ReactNode;
  readonly draggable?: boolean;
  readonly handleLabel?: string;
  readonly onHandleKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  readonly onDragOver?: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop?: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd?: () => void;
}) {
  return <article className={`universal-card ${title === undefined ? "" : "universal-card--titled"} ${className}`} style={style} onDragOver={onDragOver} onDrop={onDrop}>
    <header className="universal-card__head"><span className="universal-card__ordinal">{String(ordinal).padStart(2, "0")}</span>{title === undefined ? null : <h2>{title}</h2>}<CardHandle label={handleLabel ?? `Reorder card ${String(ordinal)}`} draggable={draggable} onKeyDown={onHandleKeyDown ?? (() => undefined)} onDragStart={onDragStart} onDragEnd={onDragEnd} /></header>
    <div className="universal-card__body">{children}</div>
  </article>;
}

function metricPercent(metric: OperatorOverview["cpu"] | OperatorOverview["ram"] | OperatorOverview["disk"]): number | undefined {
  return metric.state === "available" ? Math.min(100, Math.max(0, metric.percent)) : undefined;
}

function isOperatorOverview(value: unknown): value is OperatorOverview {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.sampledAt === "string"
    && typeof record.cpu === "object" && record.cpu !== null
    && typeof record.ram === "object" && record.ram !== null
    && typeof record.disk === "object" && record.disk !== null
    && typeof record.uptime === "object" && record.uptime !== null
    && typeof record.storage === "object" && record.storage !== null
    && typeof record.transfers === "object" && record.transfers !== null
    && Array.isArray((record.transfers as Record<string, unknown>).tasks);
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return `${String(days)}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

const DASHBOARD_CARD_LAYOUT: Readonly<Record<DashboardCardName, { readonly columns: 1 | 2 | 4; readonly rows: 1 | 2 }>> = {
  cpu: { columns: 2, rows: 1 },
  ram: { columns: 2, rows: 1 },
  disk: { columns: 2, rows: 1 },
  uptime: { columns: 2, rows: 1 },
  storage: { columns: 4, rows: 1 },
  drop: { columns: 1, rows: 1 },
  reachability: { columns: 1, rows: 1 },
  tasks: { columns: 4, rows: 2 },
};

function dashboardPlacements(order: readonly DashboardCardName[]): ReadonlyMap<DashboardCardName, CSSProperties> {
  const placements = new Map<DashboardCardName, CSSProperties>();
  const oneColumnStarts = [1, 3, 5, 7] as const;
  const oneColumnEnds = [2, 4, 6, 8] as const;
  let row = 1;
  let unit = 0;
  for (const id of order) {
    const layout = DASHBOARD_CARD_LAYOUT[id];
    if (layout.columns === 4) {
      if (unit > 0) { row += 1; unit = 0; }
      placements.set(id, { gridColumn: "1 / 8", gridRow: `${String(row)} / span ${String(layout.rows)}` });
      row += layout.rows;
      continue;
    }
    if (layout.columns === 2) {
      if (unit === 1 || unit === 3 || unit > 2) { row += 1; unit = 0; }
      placements.set(id, { gridColumn: unit === 0 ? "1 / 4" : "5 / 8", gridRow: String(row) });
      unit += 2;
    } else {
      placements.set(id, { gridColumn: `${String(oneColumnStarts[unit] ?? 1)} / ${String(oneColumnEnds[unit] ?? 2)}`, gridRow: String(row) });
      unit += 1;
    }
    if (unit >= 4) { row += 1; unit = 0; }
  }
  return placements;
}

function formatRate(bytesPerSecond: number | undefined): string {
  return bytesPerSecond === undefined ? "Sampling…" : `${formatBytes(Math.max(0, Math.round(bytesPerSecond)))}/s`;
}

const TRANSFER_STATE_LABELS: Readonly<Record<OperatorOverview["transfers"]["tasks"][number]["state"], string>> = {
  queued: "Queued",
  uploading: "Uploading",
  scanning: "Scanning",
  compressing: "Compressing",
  extracting: "Extracting",
  verifying: "Verifying",
  committing: "Committing",
  waiting_retry: "Waiting retry",
  downloading: "Downloading",
  paused: "Paused",
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
};

function TransferTasksBody({ overview, controllingTaskId, onControl }: {
  readonly overview: OperatorOverview | undefined;
  readonly controllingTaskId: string | undefined;
  readonly onControl: (task: OperatorOverview["transfers"]["tasks"][number], action: "pause" | "resume" | "cancel") => void;
}) {
  const transfers = overview?.transfers;
  const tasks = transfers?.tasks ?? [];
  return <div className="transfer-panel">
    <div className="transfer-flow" aria-label="Aggregate transfer flow">
      <div><span>Upload flow</span><strong>{formatRate(transfers?.uploadBytesPerSecond)}</strong></div>
      <div><span>Download flow</span><strong>{formatRate(transfers?.downloadBytesPerSecond)}</strong></div>
      <div><span>Active</span><strong>{transfers === undefined ? "Unavailable" : String(transfers.activeCount)}</strong></div>
      <div><span>Queued</span><strong>{transfers === undefined ? "Unavailable" : String(transfers.queuedCount)}</strong></div>
    </div>
    <div className="transfer-list" aria-live="polite">
      {transfers === undefined ? <p className="transfer-empty">Transfer telemetry unavailable.</p> : tasks.length === 0 ? <p className="transfer-empty">No active or queued file transfers.</p> : tasks.map((task) => <article className="transfer-task" key={`${task.direction}:${task.id}`}>
        <div className="transfer-task__identity"><span>{task.direction === "upload" ? "UPLOAD" : task.direction === "download" ? "DOWNLOAD" : "ARCHIVE"}</span><strong title={task.filename}>{task.filename}</strong></div>
        <div className="transfer-task__state"><span>{TRANSFER_STATE_LABELS[task.state]}{task.queuePosition === undefined ? "" : ` · #${String(task.queuePosition)}`}</span><strong>{task.percent.toFixed(1)}%</strong></div>
        <div className="transfer-task__progress"><progress max={100} value={task.percent} aria-label={`${task.filename} ${task.percent.toFixed(1)}%`} /><span>{formatBytes(task.transferredBytes)} / {formatBytes(task.totalBytes)}</span></div>
        <strong className="transfer-task__rate">{formatRate(task.bytesPerSecond)}</strong>
        <div className="transfer-task__actions" aria-label={`Controls for ${task.filename}`}>
          <button className="button" type="button" disabled={!task.canPause || controllingTaskId !== undefined} onClick={() => onControl(task, "pause")}>Pause</button>
          <button className="button" type="button" disabled={(!task.canResume && recoverableOwnerUpload(task.id) === undefined) || controllingTaskId !== undefined} onClick={() => onControl(task, "resume")}>Resume</button>
          <button className="button button--danger" type="button" disabled={!task.canCancel || controllingTaskId !== undefined} onClick={() => onControl(task, "cancel")}>Cancel</button>
        </div>
      </article>)}
    </div>
    <time className="transfer-sampled" dateTime={overview?.sampledAt}>{overview === undefined ? "No current sample" : `Updated ${new Date(overview.sampledAt).toLocaleTimeString()}`}</time>
  </div>;
}

async function copyText(value: string): Promise<boolean> {
  const clipboard = Reflect.get(navigator, "clipboard") as Clipboard | undefined;
  try {
    if (clipboard !== undefined) {
      await clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy path for restrictive browser contexts.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  const execute = Reflect.get(document, "execCommand") as ((command: string) => boolean) | undefined;
  try { return execute?.call(document, "copy") ?? false; }
  catch { return false; }
  finally { textarea.remove(); }
}

function beginClipboardWrite(challenge: Promise<{ readonly code: string }>): Promise<boolean> | undefined {
  const clipboard = Reflect.get(navigator, "clipboard") as Clipboard | undefined;
  if (clipboard === undefined || typeof ClipboardItem === "undefined") return undefined;
  try {
    const item = new ClipboardItem({
      "text/plain": challenge.then((value) => new Blob([value.code], { type: "text/plain" })),
    });
    return clipboard.write([item]).then(() => true).catch(() => false);
  } catch {
    return undefined;
  }
}

function DropCodeButton({ addNotice }: { readonly addNotice: (kind: Notice["kind"], message: string) => void }) {
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<{ readonly code: string; readonly expiresAt: string; readonly copied: boolean } | undefined>();

  const create = async () => {
    if (pending) return;
    setPending(true);
    try {
      const challengeRequest = api.createDropCode();
      const earlyCopy = beginClipboardWrite(challengeRequest);
      const challenge = await challengeRequest;
      const copiedEarly = earlyCopy === undefined ? false : await earlyCopy;
      const copied = copiedEarly || await copyText(challenge.code);
      setIssued({ ...challenge, copied });
      addNotice(copied ? "success" : "error", copied
        ? "Drop point code created and copied to the clipboard."
        : "Drop point code created, but the browser blocked clipboard access. Copy it from the card.");
    } catch {
      addNotice("error", "Drop point code could not be created.");
    } finally {
      setPending(false);
    }
  };

  const detail = issued === undefined
    ? "Create a shared temporary upload code"
    : `${issued.copied ? "Copied" : "Copy manually"} · expires ${new Date(issued.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return <button className="metric metric--action" type="button" aria-label="Create and copy Drop point code" disabled={pending} onClick={() => void create()}>
    <span className="metric__title" role="heading" aria-level={2}>Drop point code</span>
    <strong>{pending ? "Creating…" : issued?.code ?? "Create & copy"}</strong>
    <span>{detail}</span>
  </button>;
}

function DashboardView({ storageHealth, preferences, setPreferences, addNotice }: {
  readonly storageHealth: GatewayState;
  readonly preferences: Omit<OwnerPreferences, "updatedAt">;
  readonly setPreferences: (value: Omit<OwnerPreferences, "updatedAt">) => void;
  readonly addNotice: (kind: Notice["kind"], message: string) => void;
}) {
  const [overview, setOverview] = useState<OperatorOverview | undefined>();
  const [controllingTaskId, setControllingTaskId] = useState<string | undefined>();
  const resumeInput = useRef<HTMLInputElement>(null);
  const resumeTask = useRef<OperatorOverview["transfers"]["tasks"][number] | undefined>(undefined);
  const [dragging, setDragging] = useState<DashboardCardName | undefined>();
  const [dropTarget, setDropTarget] = useState<DashboardCardName | undefined>();
  const load = useCallback(async () => {
    try { const value: unknown = await api.overview(); setOverview(isOperatorOverview(value) ? value : undefined); }
    catch { setOverview(undefined); }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 2_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [load]);
  const persist = async (next: readonly DashboardCardName[]) => {
    const previous = preferences;
    const candidate = { ...preferences, dashboardOrder: next };
    setPreferences(candidate);
    try { setPreferences(ownerPreferences(await api.updatePreferences(candidate))); }
    catch { setPreferences(previous); addNotice("error", "Dashboard order could not be saved."); }
  };
  const move = (source: DashboardCardName, target: DashboardCardName) => {
    if (source === target) return;
    const next = preferences.dashboardOrder.filter((item) => item !== source);
    next.splice(next.indexOf(target), 0, source);
    void persist(next);
  };
  const keyMove = (event: ReactKeyboardEvent<HTMLButtonElement>, item: DashboardCardName) => {
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const index = preferences.dashboardOrder.indexOf(item);
    const target = preferences.dashboardOrder[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (target !== undefined) move(item, target);
  };
  const controlTask = async (task: OperatorOverview["transfers"]["tasks"][number], action: "pause" | "resume" | "cancel") => {
    if (controllingTaskId !== undefined) return;
    setControllingTaskId(task.id);
    try {
      await api.controlTransferTask(task.id, action);
      if (action === "cancel") forgetRecoverableOwnerUpload(task.id);
      addNotice("success", `Task ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`);
      await load();
    } catch {
      addNotice("error", `Task could not be ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`);
    } finally {
      setControllingTaskId(undefined);
    }
  };
  const requestTaskControl = (task: OperatorOverview["transfers"]["tasks"][number], action: "pause" | "resume" | "cancel") => {
    if (action === "resume" && recoverableOwnerUpload(task.id) !== undefined) {
      resumeTask.current = task;
      resumeInput.current?.click();
      return;
    }
    void controlTask(task, action);
  };
  const resumeDetachedUpload = async (file: File | undefined) => {
    const task = resumeTask.current;
    resumeTask.current = undefined;
    if (file === undefined || task === undefined || controllingTaskId !== undefined) return;
    setControllingTaskId(task.id);
    try {
      if (task.state === "paused") await api.controlTransferTask(task.id, "resume");
      await resumeOwnerUpload(task.id, file, () => undefined);
      addNotice("success", "Upload resumed from its verified server offset and completed.");
      await load();
    } catch (error) {
      addNotice("error", error instanceof Error ? error.message : "Upload could not be resumed.");
      await load();
    } finally {
      setControllingTaskId(undefined);
      if (resumeInput.current !== null) resumeInput.current.value = "";
    }
  };
  const placements = useMemo(() => dashboardPlacements(preferences.dashboardOrder), [preferences.dashboardOrder]);
  const content: Record<DashboardCardName, ReactNode> = {
    cpu: <DashboardMetricBody title="CPU Usage" value={overview?.cpu.state === "available" ? `${overview.cpu.percent.toFixed(1)}%  [ ${String(overview.cpu.logicalCores)} logical cores ]` : "Unavailable"} percent={overview === undefined ? undefined : metricPercent(overview.cpu)} detail="Current API process utilization" />,
    ram: <DashboardMetricBody title="RAM Usage" value={overview?.ram.state === "available" ? `${overview.ram.percent.toFixed(1)}%  [ ${formatBytes(overview.ram.usedBytes)} / ${formatBytes(overview.ram.totalBytes)} ]` : "Unavailable"} percent={overview === undefined ? undefined : metricPercent(overview.ram)} detail={overview?.ram.state === "available" ? `API process ${formatBytes(overview.ram.processBytes)}` : "No reliable sample"} />,
    disk: <DashboardMetricBody title="Disk Usage" value={overview?.disk.state === "available" ? `${overview.disk.percent.toFixed(1)}%  [ ${formatBytes(overview.disk.usedBytes)} / ${formatBytes(overview.disk.totalBytes)} ]` : "Unavailable"} percent={overview === undefined ? undefined : metricPercent(overview.disk)} detail={overview?.disk.state !== "available" ? overview?.disk.reason ?? "No reliable sample" : "Local volume hosting the API"} />,
    uptime: <DashboardMetricBody title="Uptime" value={overview?.uptime.state === "available" ? formatUptime(overview.uptime.seconds) : "Unavailable"} detail="Current API process" />,
    storage: <DashboardStorageBody storage={overview?.storage} />,
    drop: <DropCodeButton addNotice={addNotice} />,
    reachability: <DashboardMetricBody title="Storage Reachability" value={storageHealth === "ready" ? "Available" : storageHealth === "checking" ? "Checking" : "Unavailable"} detail="SFTP storage readiness check" tone={storageHealth === "ready" ? "success" : "danger"} />,
    tasks: <TransferTasksBody overview={overview} controllingTaskId={controllingTaskId} onControl={requestTaskControl} />,
  };
  return <section className="workspace" aria-labelledby="dashboard-title">
    <input ref={resumeInput} className="visually-hidden-input" type="file" aria-label="Resume upload source" onChange={(event) => void resumeDetachedUpload(event.target.files?.[0])} />
    <PageHeader title="dashboard" id="dashboard-title" />
    <div className="card-grid card-grid--dashboard">
      {preferences.dashboardOrder.map((id, index) => <UniversalCard
        ordinal={index + 1}
        {...(id === "tasks" ? { title: "Tasks" } : {})}
        className={`${id === "tasks" ? "dashboard-card--tasks" : "universal-card--metric"} dashboard-card--${String(DASHBOARD_CARD_LAYOUT[id].columns)}x${String(DASHBOARD_CARD_LAYOUT[id].rows)}${dropTarget === id ? " universal-card--drop-target" : ""}`}
        style={placements.get(id) ?? {}}
        draggable
        handleLabel={`Reorder ${id} card`}
        onHandleKeyDown={(event) => keyMove(event, id)}
        onDragStart={(event) => { setDragging(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); }}
        onDragOver={(event) => { if (dragging !== undefined && dragging !== id) { event.preventDefault(); setDropTarget(id); } }}
        onDrop={(event) => { event.preventDefault(); if (dragging !== undefined) move(dragging, id); setDragging(undefined); setDropTarget(undefined); }}
        onDragEnd={() => { setDragging(undefined); setDropTarget(undefined); }}
        key={id}
      >{content[id]}</UniversalCard>)}
    </div>
  </section>;
}

function DashboardMetricBody({ title, value, percent, detail, tone }: { readonly title: string; readonly value: string; readonly percent?: number | undefined; readonly detail: string; readonly tone?: "success" | "danger" }) {
  const percentLabel = percent === undefined ? "" : formatMetricPercent(percent);
  return <div className={`metric${tone === undefined ? "" : ` metric--${tone}`}`}><h2>{title}</h2><strong>{value}</strong><span>{detail}</span>{percent === undefined ? null : <div className="metric__progress" role="meter" aria-label={`${title} ${percentLabel}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={percentLabel}><i style={{ width: `${String(percent)}%`, minWidth: percent > 0 ? "1px" : undefined }} /></div>}</div>;
}

function formatMetricPercent(percent: number): string {
  if (percent === 0) return "0%";
  if (percent < 0.00001) return "<0.00001%";
  if (percent < 0.001) return `${percent.toFixed(5)}%`;
  if (percent < 0.1) return `${percent.toFixed(3)}%`;
  return `${percent.toFixed(1)}%`;
}

function DashboardStorageBody({ storage }: { readonly storage: OperatorOverview["storage"] | undefined }) {
  if (storage === undefined || storage.state === "unavailable") {
    return <DashboardMetricBody title="Storage" value="Unavailable" detail={storage?.reason ?? "No reliable sample"} />;
  }
  if (storage.capacity.state === "unavailable" || storage.capacity.totalBytes <= 0) {
    const contentLabel = `${String(storage.directoryCount)} ${storage.directoryCount === 1 ? "folder" : "folders"} / ${String(storage.fileCount)} ${storage.fileCount === 1 ? "file" : "files"}`;
    const capacityLabel = storage.capacity.state === "unavailable" && storage.capacity.reason.includes("Local DEV")
      ? "Local DEV backing disk excluded"
      : "Capacity unavailable";
    return <DashboardMetricBody title="Storage" value={formatBytes(storage.indexedBytes)} detail={`${contentLabel} · ${capacityLabel}`} />;
  }
  const percent = Math.min(100, Math.max(0, storage.capacity.usedBytes / storage.capacity.totalBytes * 100));
  const contentLabel = `${String(storage.directoryCount)} ${storage.directoryCount === 1 ? "folder" : "folders"} / ${String(storage.fileCount)} ${storage.fileCount === 1 ? "file" : "files"}`;
  return <DashboardMetricBody
    title="Storage"
    value={`${formatBytes(storage.capacity.usedBytes)} / ${formatBytes(storage.capacity.totalBytes)}`}
    percent={percent}
    detail={`${formatMetricPercent(percent)} occupied · ${formatBytes(storage.indexedBytes)} indexed · ${contentLabel}`}
  />;
}

function PageHeader({ eyebrow, title, id }: { readonly eyebrow?: string; readonly title: string; readonly id: string }) {
  return <header className="workspace__head"><div>{eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}<h1 className="page-title" id={id}>{title}</h1></div></header>;
}

function DocumentationView() {
  return <section className="workspace" aria-labelledby="documentation-title">
    <PageHeader eyebrow="Saturn operator reference" title="Documentation" id="documentation-title" />
    <div className="documentation-content">
      <UniversalCard ordinal={1} title="Storage model"><p>All storage access passes through Saturn Gateway. The owner UI never receives Storage Box credentials.</p><p>Preinstalled root folders are rename-only; ordinary root folders remain fully manageable.</p></UniversalCard>
      <UniversalCard ordinal={2} title="Access model"><p>The owner workspace uses one Access Key. Drop sessions, shared links, devices and backup producers use separate scoped capabilities.</p></UniversalCard>
      <UniversalCard ordinal={3} title="Operations"><p>Implementation, verification and recovery runbooks are maintained in the project documentation directory on the Saturn host.</p></UniversalCard>
      <UniversalCard ordinal={4} title="Changing storage"><p>Settings → Security can validate and select an independent SFTP target after recent owner proof. Saturn migrates zero file bytes, rebuilds the visible catalog and revokes capabilities that belonged to the previous file set.</p><p>The previous storage remains untouched. Selecting it again requires its credential and performs another validated index rebuild.</p></UniversalCard>
    </div>
  </section>;
}

function StatusRow({ label, state, detail }: { readonly label: string; readonly state: "ready" | "unavailable" | "busy"; readonly detail?: string | undefined }) {
  return <div className="status-row"><span>{label}</span><span className={`semantic-status semantic-status--${state}`}>{detail ?? (state === "ready" ? "Service Reachability" : state === "busy" ? "Busy" : "Unavailable")}<i aria-hidden="true" /></span></div>;
}

function NeptunePipelineRow({ service, agent, release, pending, reauthed, onSchedule, onCommand, onCheckUpdate, onInstallUpdate, onSetup, onRotate, onRevoke }: {
  readonly service: BackupServiceInfo;
  readonly agent?: NeptuneAgentInfo | undefined;
  readonly release?: NeptuneReleaseCheck | undefined;
  readonly pending: boolean;
  readonly reauthed: boolean;
  readonly onSchedule: (service: BackupServiceInfo, archiveEnabled: boolean, archiveIntervalHours: number, mirrorEnabled: boolean, mirrorIntervalMinutes: number) => Promise<void>;
  readonly onCommand: (service: BackupServiceInfo, kind: "archive.run" | "mirror.run") => Promise<void>;
  readonly onCheckUpdate: (service: BackupServiceInfo) => Promise<void>;
  readonly onInstallUpdate: (service: BackupServiceInfo, version: string) => Promise<void>;
  readonly onSetup: (id: string) => Promise<void>;
  readonly onRotate: (id: string) => Promise<void>;
  readonly onRevoke: (id: string) => Promise<void>;
}) {
  const [archiveEnabled, setArchiveEnabled] = useState(agent?.desired.archiveEnabled ?? false);
  const [archiveHours, setArchiveHours] = useState(agent?.desired.archiveIntervalHours ?? 24);
  const [mirrorEnabled, setMirrorEnabled] = useState(agent?.desired.mirrorEnabled ?? false);
  const [mirrorMinutes, setMirrorMinutes] = useState(agent?.desired.mirrorIntervalMinutes ?? 5);
  useEffect(() => {
    setArchiveEnabled(agent?.desired.archiveEnabled ?? false);
    setArchiveHours(agent?.desired.archiveIntervalHours ?? 24);
    setMirrorEnabled(agent?.desired.mirrorEnabled ?? false);
    setMirrorMinutes(agent?.desired.mirrorIntervalMinutes ?? 5);
  }, [agent?.desired.revision]);
  const lastSeenAt = agent?.observed.lastSeenAt;
  const online = lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < 45_000;
  const applied = agent !== undefined && agent.observed.appliedRevision >= agent.desired.revision;
  const archiveActive = agent?.observed.archive["active"] === true;
  const mirrorActive = agent?.observed.mirror["active"] === true;
  const versionPending = agent?.desired.version !== undefined && agent.desired.version !== agent.observed.version;
  const updateVersion = release?.update_available === true && release.available_version !== agent?.observed.version ? release.available_version : undefined;
  const heartbeat = online
    ? `online · Neptune ${agent?.observed.version ?? "unknown"}`
    : lastSeenAt === undefined ? "waiting for first check-in" : `offline · last seen ${new Date(lastSeenAt).toLocaleString()}`;
  const disabled = pending || service.state !== "active";
  const save = (next?: { readonly archiveEnabled?: boolean; readonly mirrorEnabled?: boolean }) => onSchedule(service,
    next?.archiveEnabled ?? archiveEnabled, archiveHours, next?.mirrorEnabled ?? mirrorEnabled, mirrorMinutes);
  return <article className="fleet-agent">
    <div className="fleet-agent__summary"><strong>{service.name}</strong><span>{service.namespaceSlug}/{service.deploymentId} · {service.state} · {formatBytes(service.usage.storedBytes)}/{formatBytes(service.storedQuotaBytes)} stored</span><span>{heartbeat} · {applied ? "schedule applied" : "schedule pending"}{versionPending ? ` · update ${agent.desired.version} pending` : ""}</span>{agent?.observed.latestError === undefined ? null : <span className="danger-text">{agent.observed.latestError}</span>}</div>
    <div className="fleet-agent__schedule">
      <label><input type="checkbox" checked={archiveEnabled} disabled={disabled} onChange={(event) => { setArchiveEnabled(event.target.checked); void save({ archiveEnabled: event.target.checked }); }} />Automatic ZIP</label>
      <label>Every, hours<input type="number" min={1} max={8760} value={archiveHours} disabled={disabled} onChange={(event) => setArchiveHours(Number(event.target.value))} onBlur={() => void save()} /></label>
      <button className="button" type="button" disabled={disabled || !online || archiveActive} onClick={() => void onCommand(service, "archive.run")}>Run ZIP now</button>
      {service.mirrorRoot === undefined ? null : <>
        <label><input type="checkbox" checked={mirrorEnabled} disabled={disabled} onChange={(event) => { setMirrorEnabled(event.target.checked); void save({ mirrorEnabled: event.target.checked }); }} />Automatic /{service.mirrorRoot} mirror</label>
        <label>Every, minutes<input type="number" min={1} max={10080} value={mirrorMinutes} disabled={disabled} onChange={(event) => setMirrorMinutes(Number(event.target.value))} onBlur={() => void save()} /></label>
        <button className="button" type="button" disabled={disabled || !online || mirrorActive} onClick={() => void onCommand(service, "mirror.run")}>Run mirror now</button>
      </>}
    </div>
    <div className="inline-actions"><button className="button" type="button" disabled={pending || !online} onClick={() => void onCheckUpdate(service)}>Check update</button>{updateVersion === undefined ? release === undefined ? null : <span className="setting-meta">Up to date</span> : <button className="button button--primary" type="button" disabled={pending || !online || versionPending} onClick={() => void onInstallUpdate(service, updateVersion)}>Update to {updateVersion}</button>}<button className="button" type="button" disabled={pending || !reauthed || service.state !== "active"} onClick={() => void onSetup(service.id)}>Setup code</button><button className="button" type="button" disabled={pending || !reauthed || service.state !== "active"} onClick={() => void onRotate(service.id)}>Rotate archive token</button><button className="button button--danger" type="button" disabled={pending || !reauthed || service.state !== "active"} onClick={() => void onRevoke(service.id)}>Revoke</button></div>
  </article>;
}

function SynchronizationView({ addNotice }: { readonly addNotice: (kind: Notice["kind"], message: string) => void }) {
  const [pending, setPending] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [reauthed, setReauthed] = useState(false);
  const [agents, setAgents] = useState<readonly NeptuneAgentInfo[]>([]);
  const [agentReleases, setAgentReleases] = useState<Readonly<Record<string, NeptuneReleaseCheck>>>({});
  const [services, setServices] = useState<readonly BackupServiceInfo[]>([]);
  const [devices, setDevices] = useState<readonly DeviceInfo[]>([]);
  const [pipeline, setPipeline] = useState<"archive" | "volt" | "mastermind">("archive");
  const [serviceName, setServiceName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [deployment, setDeployment] = useState("");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(4);
  const [enrollment, setEnrollment] = useState<{ readonly code: string; readonly expiresAt: string } | undefined>();
  const [producerToken, setProducerToken] = useState<string | undefined>();
  const [windowsName, setWindowsName] = useState("");
  const [windowsToken, setWindowsToken] = useState<string | undefined>();

  const loadAgents = async () => { try { setAgents(await api.neptuneAgents()); } catch { addNotice("error", "Remote Neptune state could not be loaded."); } };
  const loadServices = async () => { try { setServices(await api.backupServices()); } catch { addNotice("error", "Neptune identities could not be loaded."); } };
  const loadDevices = async () => { try { setDevices(await api.devices()); } catch { addNotice("error", "Synchronization clients could not be loaded."); } };
  useEffect(() => { void Promise.all([loadAgents(), loadServices(), loadDevices()]); }, []);
  useEffect(() => { const timer = window.setInterval(() => { void loadAgents(); }, 15_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!reauthed) return;
    const timeout = window.setTimeout(() => setReauthed(false), 5 * 60_000);
    return () => window.clearTimeout(timeout);
  }, [reauthed]);

  const reauthenticate = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessKey) return;
    setPending(true);
    try { await api.reauthenticate(accessKey); setAccessKey(""); setReauthed(true); addNotice("success", "Synchronization management unlocked."); }
    catch { setAccessKey(""); setReauthed(false); addNotice("error", "Re-authentication failed."); }
    finally { setPending(false); }
  };
  const changePipeline = (value: "archive" | "volt" | "mastermind") => {
    setPipeline(value);
    if (value === "volt" || value === "mastermind") setNamespace(value);
  };
  const createService = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const selectedNamespace = pipeline === "archive" ? namespace : pipeline;
    if (!serviceName || !selectedNamespace || !deployment) return;
    setPending(true);
    try {
      const created = await api.createBackupEnrollment({
        name: serviceName,
        namespaceSlug: selectedNamespace,
        deploymentId: deployment,
        requireEncryption: false,
        maxConcurrentRuns,
        ...(pipeline === "archive" ? {} : { mirrorRoot: pipeline }),
      });
      setEnrollment({ code: created.code, expiresAt: created.expiresAt });
      setServiceName(""); setDeployment("");
      if (pipeline === "archive") setNamespace("");
      await Promise.all([loadServices(), loadAgents()]);
      addNotice("success", "One-time Neptune setup code created.");
    } catch (error) {
      if (error instanceof ApiError && error.code === "reauth_required") { setReauthed(false); addNotice("error", "Owner proof expired. Unlock management again."); }
      else if (error instanceof ApiError && (error.code === "identity_conflict" || error.code === "conflict")) addNotice("error", "This project/server pair or dedicated mirror root is already active. Use Setup code on the existing identity.");
      else addNotice("error", "Linux pipeline could not be created.");
    }
    finally { setPending(false); }
  };
  const createEnrollment = async (id: string) => {
    setPending(true);
    try { const created = await api.createBackupServiceEnrollment(id); setEnrollment({ code: created.code, expiresAt: created.expiresAt }); addNotice("success", "Replacement setup code created."); }
    catch { addNotice("error", "Creating a setup code requires recent owner proof."); }
    finally { setPending(false); }
  };
  const rotateService = async (id: string) => {
    setPending(true);
    try { const rotated = await api.rotateBackupService(id); setProducerToken(rotated.token); await loadServices(); addNotice("success", "Archive producer token rotated."); }
    catch { addNotice("error", "Token rotation requires recent owner proof."); }
    finally { setPending(false); }
  };
  const revokeService = async (id: string) => {
    setPending(true);
    try { await api.revokeBackupService(id); await Promise.all([loadServices(), loadDevices(), loadAgents()]); addNotice("success", "Neptune identity and its linked mirror access were revoked."); }
    catch { addNotice("error", "Revocation requires recent owner proof."); }
    finally { setPending(false); }
  };
  const createWindowsClient = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!windowsName) return; setPending(true);
    try {
      const created = await api.createDevice({ name: windowsName, scopeIds: [SYNC_RESOURCE_ID], rights: { read: true, write: true, move: true, delete: true } });
      setWindowsToken(created.token); setWindowsName(""); await loadDevices(); addNotice("success", "Windows sync client created.");
    } catch { addNotice("error", "Creating a Windows client requires recent owner proof."); }
    finally { setPending(false); }
  };
  const revokeDevice = async (id: string) => {
    setPending(true);
    try { await api.revokeDevice(id); await loadDevices(); addNotice("success", "Windows synchronization access revoked."); }
    catch { addNotice("error", "Revocation requires recent owner proof."); }
    finally { setPending(false); }
  };
  const saveAgentSchedule = async (service: BackupServiceInfo, archiveEnabled: boolean, archiveIntervalHours: number, mirrorEnabled: boolean, mirrorIntervalMinutes: number) => {
    setPending(true);
    try {
      await api.updateNeptuneAgentSchedule(service.id, { archiveEnabled, archiveIntervalHours, ...(service.mirrorRoot === undefined ? {} : { mirrorEnabled, mirrorIntervalMinutes }) });
      await loadAgents(); addNotice("success", `Schedule for ${service.namespaceSlug}/${service.deploymentId} saved.`);
    } catch { addNotice("error", "Remote schedule could not be saved."); }
    finally { setPending(false); }
  };
  const commandAgent = async (service: BackupServiceInfo, kind: "archive.run" | "mirror.run") => {
    setPending(true);
    try { await api.commandNeptuneAgent(service.id, { kind }); addNotice("success", `Command queued for ${service.namespaceSlug}/${service.deploymentId}.`); }
    catch { addNotice("error", "Remote Neptune command could not be queued."); }
    finally { setPending(false); }
  };
  const checkAgentUpdate = async (service: BackupServiceInfo) => {
    setPending(true);
    try {
      const release = await api.checkNeptuneAgentUpdate(service.id);
      setAgentReleases((current) => ({ ...current, [service.id]: release }));
      addNotice("info", release.update_available ? `Neptune ${release.available_version ?? "update"} is available for ${service.name}.` : `${service.name} is up to date.`);
    } catch { addNotice("error", "Neptune release availability could not be checked."); }
    finally { setPending(false); }
  };
  const installAgentUpdate = async (service: BackupServiceInfo, version: string) => {
    setPending(true);
    try {
      await api.commandNeptuneAgent(service.id, { kind: "agent.update", version });
      addNotice("success", `Neptune ${version} update queued for ${service.name}.`);
      await loadAgents();
    } catch { addNotice("error", "Neptune update could not be queued."); }
    finally { setPending(false); }
  };

  const archiveServices = services.filter((service) => service.mirrorRoot === undefined);
  const mirrorServices = services.filter((service) => service.mirrorRoot !== undefined);
  const linkedMirrorDevices = new Set(mirrorServices.flatMap((service) => service.mirrorDeviceId === undefined ? [] : [service.mirrorDeviceId]));
  const windowsDevices = devices.filter((device) => device.scopeIds.length === 1 && device.scopeIds[0] === SYNC_RESOURCE_ID && !linkedMirrorDevices.has(device.id));
  const identityList = (items: readonly BackupServiceInfo[]) => <div className="compact-list fleet-list">{items.length === 0 ? <p className="empty-state">No identities configured.</p> : items.map((service) => <NeptunePipelineRow key={service.id} service={service} agent={agents.find((agent) => agent.serviceId === service.id)} release={agentReleases[service.id]} pending={pending} reauthed={reauthed} onSchedule={saveAgentSchedule} onCommand={commandAgent} onCheckUpdate={checkAgentUpdate} onInstallUpdate={installAgentUpdate} onSetup={createEnrollment} onRotate={rotateService} onRevoke={revokeService} />)}</div>;

  return <section className="workspace synchronization" aria-labelledby="synchronization-title">
    <PageHeader title="synchronization" id="synchronization-title" />
    <div className="synchronization-intro"><p>Three isolated pipelines share Saturn storage without sharing credentials or schedules. Linux ZIP archives are immutable recovery points; Linux mirrors keep dedicated roots current; Windows clients mirror selected folders into unique <code>sync/&lt;folder&gt;</code> destinations.</p><form className="reauth-form" onSubmit={(event) => void reauthenticate(event)}><label>Current Access Key<input type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} autoComplete="current-password" required /></label><button className="button" type="submit" disabled={pending || !accessKey}>{reauthed ? "Owner verified" : "Unlock management"}</button></form></div>
    <div className="card-grid synchronization-grid">
      <UniversalCard ordinal={1} title="Linux · recovery archives" className="synchronization-card"><p>Each remote Neptune checks in over outbound HTTPS, applies the schedule stored here and creates immutable recovery ZIPs under <code>backups/&lt;project&gt;/&lt;server&gt;</code>.</p>{identityList(archiveServices)}</UniversalCard>
      <UniversalCard ordinal={2} title="Linux · dedicated mirrors" className="synchronization-card"><p>Volt publishes <code>personal.volt</code> into <code>/volt</code>; Mastermind publishes its vault tree into <code>/mastermind</code>. Archive and mirror schedules remain independent.</p>{identityList(mirrorServices)}</UniversalCard>
      <UniversalCard ordinal={3} title="Windows · folder synchronization" className="synchronization-card"><div className="settings-groups"><section className="settings-group"><p>Create one client password per PC. The desktop app chooses local directories and a unique destination name; every destination is an exact one-way mirror under <code>sync/&lt;name&gt;</code>.</p><form className="device-form" onSubmit={(event) => void createWindowsClient(event)}><label>PC / client name<input value={windowsName} onChange={(event) => setWindowsName(event.target.value)} maxLength={80} placeholder="Office PC" required /></label><button className="button" type="submit" disabled={pending || !reauthed}>Create Windows client password</button></form>{windowsToken === undefined ? null : <div className="one-time-code" role="status"><span>Paste this one-time password into Neptune for Windows</span><strong>{windowsToken}</strong><small>It is held only in this page memory.</small></div>}<div className="compact-list">{windowsDevices.length === 0 ? <p className="empty-state">No Windows clients configured.</p> : windowsDevices.map((device) => <article key={device.id}><div><strong>{device.name}</strong><span>{device.state} · last used {device.lastUsedAt === undefined ? "never" : new Date(device.lastUsedAt).toLocaleString()}</span></div><button className="button button--danger" type="button" disabled={pending || !reauthed || device.state !== "active"} onClick={() => void revokeDevice(device.id)}>Revoke</button></article>)}</div></section></div></UniversalCard>
      <UniversalCard ordinal={4} title="Add Linux pipeline" className="synchronization-card"><form className="backup-service-form" onSubmit={(event) => void createService(event)}><label>Pipeline<select value={pipeline} onChange={(event) => changePipeline(event.target.value as "archive" | "volt" | "mastermind")}><option value="archive">Recovery ZIP only</option><option value="volt">Volt ZIP + personal.volt mirror</option><option value="mastermind">Mastermind ZIP + vault mirror</option></select></label><label>Connection name<input value={serviceName} onChange={(event) => setServiceName(event.target.value)} maxLength={100} required /></label><label>Project namespace<input value={pipeline === "archive" ? namespace : pipeline} disabled={pipeline !== "archive"} onChange={(event) => setNamespace(event.target.value.toLowerCase())} pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" maxLength={63} placeholder="chronos" required /></label><label>Server ID<input value={deployment} onChange={(event) => setDeployment(event.target.value.toLowerCase())} pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" maxLength={63} placeholder="vps-1" required /></label><label>Parallel archive runs<input type="number" min={1} max={32} value={maxConcurrentRuns} onChange={(event) => setMaxConcurrentRuns(Number(event.target.value))} required /></label><button className="button button--primary" type="submit" disabled={pending || !reauthed}>Create setup code</button></form>{enrollment === undefined ? null : <div className="one-time-code" role="status"><span>Enter this in the simplified Neptune Linux installer</span><strong>{enrollment.code}</strong><small>One use · expires {new Date(enrollment.expiresAt).toLocaleString()}.</small></div>}{producerToken === undefined ? null : <div className="one-time-code" role="status"><span>Rotated archive producer token</span><strong>{producerToken}</strong><small>Use only when repairing an existing installation.</small></div>}</UniversalCard>
      <UniversalCard ordinal={5} title="Neptune fleet" className="synchronization-card"><p>Connected Linux agents report their version and last heartbeat on the pipeline rows above. Commands and schedules are delivered through outbound polling, so no inbound server port is required.</p><p className="setting-meta">Windows clients continue to check and install their Windows release from the desktop application.</p></UniversalCard>
    </div>
  </section>;
}

function SettingsView({ preferences, setPreferences, addNotice, onAnonymous }: {
  readonly preferences: Omit<OwnerPreferences, "updatedAt">;
  readonly setPreferences: (value: Omit<OwnerPreferences, "updatedAt">) => void;
  readonly addNotice: (kind: Notice["kind"], message: string) => void;
  readonly onAnonymous: () => void;
}) {
  const [accentDraft, setAccentDraft] = useState(preferences.accentColor);
  const [trashRetentionDraft, setTrashRetentionDraft] = useState(preferences.trashRetentionDays);
  const [uploadBufferDraft, setUploadBufferDraft] = useState(preferences.uploadBufferGiB);
  const [maximumUploadFileDraft, setMaximumUploadFileDraft] = useState(preferences.maximumUploadFileGiB);
  const [accessKey, setAccessKey] = useState("");
  const [pending, setPending] = useState(false);
  const [reauthed, setReauthed] = useState(false);
  const [revokeDialog, setRevokeDialog] = useState(false);
  const [accessKeyDialog, setAccessKeyDialog] = useState(false);
  const [accessKeyChange, setAccessKeyChange] = useState({ currentAccessKey: "", newAccessKey: "", confirmation: "" });
  const [kernelTokenDialog, setKernelTokenDialog] = useState(false);
  const [kernelToken, setKernelToken] = useState("");
  const [kernel, setKernel] = useState<KernelStatus | undefined>();
  const [kernelUrl, setKernelUrl] = useState("");
  const [recovery, setRecovery] = useState<RecoveryStatus | undefined>();
  const [neptune, setNeptune] = useState<NeptuneAvailability | undefined>();
  const [neptuneDialog, setNeptuneDialog] = useState(false);
  const [neptuneCode, setNeptuneCode] = useState("");
  const [gryphon, setGryphon] = useState<GryphonStatus | undefined>();
  const [gryphonBots, setGryphonBots] = useState<readonly GryphonBot[]>([]);
  const [gryphonBotId, setGryphonBotId] = useState("");
  const [gryphonConnectionDialog, setGryphonConnectionDialog] = useState(false);
  const [gryphonRelease, setGryphonRelease] = useState<NeptuneReleaseCheck | undefined>();
  const [gryphonChallenge, setGryphonChallenge] = useState<GryphonChallenge | undefined>();
  const [restoreDialog, setRestoreDialog] = useState(false);
  const [restoreCandidate, setRestoreCandidate] = useState<RecoveryRestoreCandidate | undefined>();
  const [restoreResult, setRestoreResult] = useState<RecoveryRestoreResult | undefined>();
  const [restoreStage, setRestoreStage] = useState<"idle" | "uploading" | "validating" | "ready" | "applying" | "complete" | "error">("idle");
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const restoreInput = useRef<HTMLInputElement>(null);
  const [updates, setUpdates] = useState<UpdateStatus | undefined>();
  const [updateDialog, setUpdateDialog] = useState(false);
  const [events, setEvents] = useState<readonly AuditEventInfo[]>([]);
  const [draggingCard, setDraggingCard] = useState<SettingsCardName | undefined>();
  const [dropCard, setDropCard] = useState<SettingsCardName | undefined>();
  const [dropBuffer, setDropBuffer] = useState<{ readonly capacity?: NonNullable<DropSessionInfo["buffer"]>; readonly sessionTtlMs: number; readonly continuationTtlMs: number; readonly workers: number; readonly intervalMs: number; readonly maximumFileBytes: number } | undefined>();
  const [storage, setStorage] = useState<StorageConnectionStatus | undefined>();
  const [storageDialog, setStorageDialog] = useState(false);
  const [storageDraft, setStorageDraft] = useState<StorageConnectionInput>({ host: "", port: 22, username: "", root: ".", hostFingerprint: "", authMode: "password_file", credential: "" });
  const [storageTested, setStorageTested] = useState(false);
  const [storageConfirmed, setStorageConfirmed] = useState(false);
  const [storageStage, setStorageStage] = useState<"idle" | "testing" | "tested" | "switching">("idle");

  useEffect(() => { setAccentDraft(preferences.accentColor); }, [preferences.accentColor]);
  useEffect(() => { setTrashRetentionDraft(preferences.trashRetentionDays); }, [preferences.trashRetentionDays]);
  useEffect(() => { setUploadBufferDraft(preferences.uploadBufferGiB); }, [preferences.uploadBufferGiB]);
  useEffect(() => { setMaximumUploadFileDraft(preferences.maximumUploadFileGiB); }, [preferences.maximumUploadFileGiB]);
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", /^#[0-9a-fA-F]{6}$/.test(accentDraft) ? accentDraft : preferences.accentColor);
    return () => { document.documentElement.style.setProperty("--accent", preferences.accentColor); };
  }, [accentDraft, preferences.accentColor]);

  const loadKernel = async () => {
    try { const value = await api.kernelStatus(); setKernel(value); setKernelUrl(value.url ?? ""); }
    catch { setKernel(undefined); }
  };
  const loadRecovery = async () => { try { setRecovery(await api.recoveryStatus()); } catch { setRecovery(undefined); } };
  const loadNeptune = async () => { try { setNeptune(await api.neptuneAvailability()); } catch { setNeptune({ installed: false, linked: false, state: "unavailable" }); } };
  const loadGryphon = useCallback(async () => {
    try {
      const raw: unknown = await api.gryphonStatus();
      if (typeof raw !== "object" || raw === null || !("connected" in raw) || typeof raw.connected !== "boolean" || !("bot" in raw) || !("binding" in raw) || !("version" in raw) || typeof raw.version !== "string" || (raw.connected && (typeof raw.bot !== "object" || raw.bot === null))) throw new Error("Invalid Gryphon status");
      const value = raw as GryphonStatus;
      setGryphon(value);
    }
    catch { setGryphon(undefined); }
  }, []);
  const loadUpdates = async () => { try { setUpdates(await api.updateStatus()); } catch { setUpdates(undefined); } };
  const loadEvents = async () => {
    try {
      const latest = await api.activity(undefined, 100);
      setEvents((current) => {
        const merged = new Map([...current, ...latest].map((item) => [item.id, item]));
        return [...merged.values()].sort((left, right) => right.sequence - left.sequence).slice(0, 200);
      });
    } catch { /* The visible unavailable state remains honest. */ }
  };
  const loadDropBuffer = async () => { try { setDropBuffer(await api.dropBuffer()); } catch { setDropBuffer(undefined); } };
  const loadStorage = async () => { try { setStorage(await api.storageStatus()); } catch { setStorage(undefined); } };
  useEffect(() => {
    void Promise.all([loadKernel(), loadRecovery(), loadNeptune(), loadGryphon(), loadUpdates(), loadEvents(), loadDropBuffer(), loadStorage()]);
    const timer = window.setInterval(() => { if (!document.hidden) void loadEvents(); }, 5_000);
    const visible = () => { if (!document.hidden) void loadEvents(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [loadGryphon]);

  const persistPreferences = async (candidate: Omit<OwnerPreferences, "updatedAt">, message: string) => {
    const previous = preferences;
    setPreferences(candidate);
    try { setPreferences(ownerPreferences(await api.updatePreferences(candidate))); addNotice("success", message); }
    catch { setPreferences(previous); addNotice("error", "Preferences could not be saved."); }
  };
  const applyAccent = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!/^#[0-9a-fA-F]{6}$/.test(accentDraft)) { addNotice("error", "Accent must be a six-digit hexadecimal color."); return; }
    setPending(true);
    try { await persistPreferences({ ...preferences, accentColor: accentDraft.toLowerCase() }, "Accent color applied."); }
    finally { setPending(false); }
  };
  const applyTrashRetention = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!Number.isSafeInteger(trashRetentionDraft) || trashRetentionDraft < 1 || trashRetentionDraft > 365) {
      addNotice("error", "Trash retention must be a whole number from 1 to 365 days.");
      return;
    }
    setPending(true);
    try { await persistPreferences({ ...preferences, trashRetentionDays: trashRetentionDraft }, "Trash retention updated."); }
    finally { setPending(false); }
  };
  const applyUploadLimits = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!Number.isSafeInteger(uploadBufferDraft) || uploadBufferDraft < 1 || uploadBufferDraft > 8_192) {
      addNotice("error", "Upload buffer must be a whole number from 1 to 8192 GiB.");
      return;
    }
    if (!Number.isSafeInteger(maximumUploadFileDraft) || maximumUploadFileDraft < 1 || maximumUploadFileDraft > 4_096) {
      addNotice("error", "Maximum file size must be a whole number from 1 to 4096 GiB.");
      return;
    }
    if (maximumUploadFileDraft * 10 > uploadBufferDraft * 9) {
      addNotice("error", "Maximum file size must not exceed 90% of the upload buffer.");
      return;
    }
    setPending(true);
    try {
      await persistPreferences({ ...preferences, uploadBufferGiB: uploadBufferDraft, maximumUploadFileGiB: maximumUploadFileDraft }, "Upload limits updated.");
      await loadDropBuffer();
    } finally { setPending(false); }
  };
  const changeSidebarMode = (sidebarMode: OwnerPreferences["sidebarMode"]) => {
    if (sidebarMode !== preferences.sidebarMode) void persistPreferences({ ...preferences, sidebarMode }, "Sidebar behavior updated.");
  };
  const persistSettingsOrder = async (next: readonly SettingsCardName[]) => {
    await persistPreferences({ ...preferences, settingsOrder: next }, "Settings order updated.");
  };
  const moveSettingsCard = (source: SettingsCardName, target: SettingsCardName) => {
    if (source === target) return;
    const next = preferences.settingsOrder.filter((item) => item !== source);
    next.splice(next.indexOf(target), 0, source);
    void persistSettingsOrder(next);
  };
  const moveSettingsCardByKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, item: SettingsCardName) => {
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const index = preferences.settingsOrder.indexOf(item);
    const target = preferences.settingsOrder[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (target !== undefined) moveSettingsCard(item, target);
  };
  const reauthenticate = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!accessKey) return; setPending(true);
    try { await api.reauthenticate(accessKey); setAccessKey(""); setReauthed(true); addNotice("success", "Recent owner proof accepted; the session was rotated."); }
    catch { setAccessKey(""); setReauthed(false); addNotice("error", "Re-authentication failed."); }
    finally { setPending(false); }
  };
  const changeOwnerAccessKey = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (accessKeyChange.newAccessKey !== accessKeyChange.confirmation) { addNotice("error", "Replacement Access Key entries do not match."); return; }
    setPending(true);
    try {
      if (!reauthed) await api.reauthenticate(accessKeyChange.currentAccessKey);
      const result = await api.changeAccessKey(accessKeyChange);
      setAccessKeyChange({ currentAccessKey: "", newAccessKey: "", confirmation: "" });
      setAccessKeyDialog(false); setReauthed(true);
      addNotice("success", `Access Key changed; ${String(result.revokedSessions)} other session(s) revoked.`);
    } catch { setAccessKeyChange({ currentAccessKey: "", newAccessKey: "", confirmation: "" }); addNotice("error", "Access Key change was rejected; the previous key remains active."); }
    finally { setPending(false); }
  };
  const changeKernelUrl = async () => {
    if (!kernelUrl || kernelUrl === kernel?.url || pending) return;
    setPending(true);
    try { const value = await api.changeKernelUrl(kernelUrl); setKernel(value); setKernelUrl(value.url ?? ""); addNotice("success", "Kernel URL validated and activated."); }
    catch { setKernelUrl(kernel?.url ?? ""); addNotice("error", "Kernel validation failed; the previous URL remains active."); }
    finally { setPending(false); }
  };
  const rotateKernelToken = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!kernelToken) return; setPending(true);
    try { const value = await api.rotateKernelToken(kernelToken); setKernel(value); setKernelToken(""); setKernelTokenDialog(false); addNotice("success", "Kernel token validated and activated."); }
    catch { setKernelToken(""); addNotice("error", "Kernel token validation failed; the previous token remains active."); }
    finally { setPending(false); }
  };
  const revoke = async () => {
    setPending(true);
    try { const result = await api.revokeSessions(); addNotice("info", `${String(result.revoked)} owner session(s) revoked.`); onAnonymous(); }
    catch { addNotice("error", "Session revocation requires recent owner proof."); setRevokeDialog(false); }
    finally { setPending(false); }
  };
  const openStorageDialog = () => {
    setStorageDraft({ host: storage?.host ?? "", port: storage?.port ?? 22, username: storage?.username ?? "", root: storage?.root ?? ".", hostFingerprint: storage?.hostFingerprint ?? "", authMode: storage?.authMode ?? "password_file", credential: "" });
    setStorageTested(false); setStorageConfirmed(false); setStorageStage("idle"); setStorageDialog(true);
  };
  const updateStorageDraft = (patch: Partial<StorageConnectionInput>) => { setStorageDraft((current) => ({ ...current, ...patch })); setStorageTested(false); setStorageStage("idle"); };
  const testStorage = async () => {
    if (pending || !storageDraft.credential) return;
    setPending(true); setStorageStage("testing");
    try { await api.testStorage(storageDraft); setStorageTested(true); setStorageStage("tested"); addNotice("success", "Storage identity, root and credential were verified."); }
    catch { setStorageTested(false); setStorageStage("idle"); addNotice("error", "Storage validation failed. The active profile was not changed."); }
    finally { setPending(false); }
  };
  const switchStorage = async () => {
    if (pending || !storageTested || !storageConfirmed || !storageDraft.credential) return;
    setPending(true); setStorageStage("switching");
    try {
      const result = await api.switchStorage(storageDraft);
      setStorage(result); setStorageDraft((current) => ({ ...current, credential: "" })); setStorageDialog(false);
      addNotice("success", `Storage switched: ${String(result.indexed?.files ?? 0)} files indexed, 0 bytes migrated.`);
      window.setTimeout(() => window.location.assign("/files"), 250);
    } catch { setStorageStage("tested"); addNotice("error", "Storage switch failed; the previous profile and catalog remain active."); }
    finally { setPending(false); }
  };
  const createRecoverySnapshot = async () => {
    if (pending) return;
    setPending(true);
    try {
      const result = await downloadRecoverySnapshot();
      addNotice("success", `${result.filename} created${result.createdAt === undefined ? "" : ` at ${new Date(result.createdAt).toLocaleString("ru-RU")}`} and downloaded.`);
    } catch {
      addNotice("error", "Snapshot creation failed. No incomplete archive was downloaded; retry is safe.");
    } finally {
      setPending(false);
      await loadRecovery();
    }
  };
  const openGryphonConnection = async () => {
    setPending(true);
    try {
      const result = await api.gryphonBots();
      setGryphonBots(result.bots);
      setGryphonBotId(result.bots.find((bot) => bot.state === "ready")?.id ?? "");
      setGryphonConnectionDialog(true);
    }
    catch { addNotice("error", "Gryphon bot list could not be loaded."); }
    finally { setPending(false); }
  };
  const initializeNeptune = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!/^[A-Za-z0-9_-]{32}$/.test(neptuneCode)) { addNotice("error", "Enter the 32-character setup code from Synchronization."); return; }
    setPending(true);
    try {
      await api.initializeNeptune(neptuneCode); setNeptuneDialog(false); setNeptuneCode("");
      addNotice("success", "Neptune initialization started. Saturn may reconnect while the service is linked.");
    } catch (error) { addNotice("error", error instanceof ApiError ? error.message : "Neptune initialization could not be started."); }
    finally { setPending(false); }
  };
  const issueGryphonLink = async () => {
    setPending(true);
    try { setGryphonChallenge(await api.issueGryphonLink()); }
    catch { addNotice("error", "Telegram link code could not be created."); }
    finally { setPending(false); }
  };
  const connectGryphon = async () => {
    if (gryphonBotId === "") return;
    setPending(true);
    try { await api.connectGryphon(gryphonBotId); setGryphonConnectionDialog(false); await loadGryphon(); addNotice("success", "Saturn function linked to Gryphon."); }
    catch { addNotice("error", "Saturn function could not be linked."); }
    finally { setPending(false); }
  };
  const disconnectGryphon = async () => {
    setPending(true);
    try { await api.disconnectGryphon(); await loadGryphon(); addNotice("success", "Saturn function unlinked from Gryphon."); }
    catch { addNotice("error", "Saturn function could not be unlinked."); }
    finally { setPending(false); }
  };
  const checkGryphonUpdate = async () => {
    setPending(true);
    try { const result = await api.checkGryphonUpdate(); setGryphonRelease(result); addNotice("success", result.update_available ? `Gryphon ${result.available_version ?? "update"} is available.` : "Gryphon is up to date."); }
    catch { addNotice("error", "Gryphon release check failed."); }
    finally { setPending(false); }
  };
  const installGryphonUpdate = async () => {
    const version = gryphonRelease?.available_version;
    if (version === undefined) return;
    setPending(true);
    try { await api.installGryphonUpdate(version); setGryphonRelease(undefined); await loadGryphon(); addNotice("success", `Gryphon ${version} installed.`); }
    catch { addNotice("error", "Gryphon update failed and the previous release was retained."); }
    finally { setPending(false); }
  };
  const openRestore = () => {
    setRestoreDialog(true); setRestoreCandidate(undefined); setRestoreResult(undefined); setRestoreStage("idle"); setRestoreProgress(0); setRestoreConfirmed(false); setRestoreError("");
  };
  const chooseRestore = async (file: File | undefined) => {
    if (file === undefined) return;
    if (recovery !== undefined && file.size > recovery.maxArchiveBytes) {
      setRestoreStage("error"); setRestoreError(`Archive exceeds the ${formatBytes(recovery.maxArchiveBytes)} compressed-size limit.`); return;
    }
    setRestoreCandidate(undefined); setRestoreResult(undefined); setRestoreProgress(0); setRestoreConfirmed(false); setRestoreError(""); setRestoreStage("uploading");
    try {
      const candidate = await uploadRecoverySnapshot(
        file,
        (progress) => { setRestoreProgress(progress); if (progress >= 1) setRestoreStage("validating"); },
        recovery?.maxChunkBytes,
      );
      setRestoreCandidate(candidate); setRestoreStage("ready");
    } catch {
      setRestoreStage("error"); setRestoreError("The archive was rejected before mutation. Select a complete compatible Saturn ZIP and try again.");
    } finally {
      if (restoreInput.current !== null) restoreInput.current.value = "";
    }
  };
  const discardRestore = async () => {
    const id = restoreCandidate?.id;
    if (id !== undefined) await api.cancelRecoveryRestore(id).catch(() => undefined);
    setRestoreDialog(false); setRestoreCandidate(undefined); setRestoreResult(undefined); setRestoreStage("idle"); setRestoreProgress(0); setRestoreConfirmed(false); setRestoreError("");
  };
  const applyRestore = async () => {
    if (restoreCandidate === undefined || !restoreConfirmed || restoreStage !== "ready") return;
    setRestoreStage("applying"); setRestoreError("");
    try {
      const result = await api.applyRecoveryRestore(restoreCandidate.id);
      setRestoreResult(result); setRestoreStage("complete"); setRestoreConfirmed(false);
      addNotice("success", `Snapshot restored and verified in ${String(result.measuredRtoMs)} ms. Sign in again before continuing.`);
    } catch (error) {
      setRestoreStage("error");
      setRestoreError(error instanceof ApiError && error.status === 500
        ? "Restore failed. Saturn attempted the verified pre-restore rollback; inspect Logs before retrying."
        : "Restore could not start. Live state was not reported as restored.");
    } finally {
      await loadRecovery().catch(() => undefined);
    }
  };

  const cards: Record<SettingsCardName, ReactNode> = {
    appearance: <div className="settings-groups">
      <form className="settings-group appearance-form" onSubmit={(event) => void applyAccent(event)}>
        <div><h3>Color correction</h3><p>Accent changes preview immediately. Only Apply color persists the value.</p></div>
        <div className="color-control"><input aria-label="Accent color picker" type="color" value={/^#[0-9a-fA-F]{6}$/.test(accentDraft) ? accentDraft : preferences.accentColor} onChange={(event) => setAccentDraft(event.target.value)} /><input aria-label="Accent color" value={accentDraft} onChange={(event) => setAccentDraft(event.target.value)} onBlur={() => setAccentDraft(/^#[0-9a-fA-F]{6}$/.test(accentDraft) ? accentDraft.toLowerCase() : preferences.accentColor)} pattern="#[0-9a-fA-F]{6}" /><button className="button" type="button" onClick={() => setAccentDraft("#00a8ff")}>Reset color</button><button className="button button--primary" type="submit" disabled={pending}>Apply color</button></div>
      </form>
      <fieldset className="settings-group sidebar-mode-fieldset"><legend>Left menu position</legend><p>Reveal the sidebar from the edge or keep it fixed on wide screens.</p><label><input type="checkbox" checked={preferences.sidebarMode === "auto-hide"} onChange={(event) => changeSidebarMode(event.target.checked ? "auto-hide" : "fixed")} />Auto-hide the left menu on wide screens</label></fieldset>
    </div>,
    security: <div className="settings-groups">
      <section className="settings-group settings-group--access"><h3>Changing Access Key</h3><p>Replacement is atomic and revokes every other active browser session.</p><button className="button settings-action" type="button" disabled={pending} onClick={() => setAccessKeyDialog(true)}>Start Access Key change</button></section>
      <section className="settings-group settings-group--kernel"><h3>Connection with Kernel</h3><form className="kernel-url-form" onSubmit={(event) => { event.preventDefault(); void changeKernelUrl(); }}><input aria-label="Kernel URL" title="Press Enter or leave the field to validate a changed endpoint" type="url" value={kernelUrl} onChange={(event) => setKernelUrl(event.target.value)} onBlur={() => void changeKernelUrl()} placeholder="https://kernel.example.net" /><StatusRow label={`${kernel?.identity ?? "Kernel Core"} · revision ${String(kernel?.revision ?? 0)}`} state={kernel === undefined ? "busy" : kernel.reachability === "ready" ? "ready" : "unavailable"} detail={kernel === undefined ? "Checking" : kernel.reachability === "ready" ? "Service Reachability" : kernel.configured ? "Unreachable" : "Not configured"} /></form><button className="button button--wide" type="button" disabled={pending || !reauthed || !kernelUrl} onClick={() => setKernelTokenDialog(true)}>Change secure Kernel access token</button></section>
      <details className="settings-group auxiliary-settings security-advanced"><summary>Advanced security and owner proof</summary><div className="settings-subgroups">
        <section className="settings-subgroup"><h3>Recent owner proof</h3><p>Unlocks Kernel, storage, device and session mutations for a short bounded window. The field always opens empty.</p><form className="reauth-form" onSubmit={(event) => void reauthenticate(event)}><label>Current Access Key<input type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} autoComplete="current-password" required /></label><button className="button" type="submit" disabled={pending || !accessKey}>Verify owner</button></form></section>
        <section className="settings-subgroup storage-connection"><h3>Storage connection</h3><p>The active SFTP profile is Gateway-only. Credentials are write-only and are never returned to this page.</p><StatusRow label={storage === undefined ? "Storage profile" : `${storage.username}@${storage.host}:${String(storage.port)} · ${storage.root}`} state={storage === undefined ? "busy" : storage.reachability === "ready" ? "ready" : "unavailable"} detail={storage === undefined ? "Checking" : `${storage.source} · revision ${String(storage.revision)}`} /><p className="setting-meta">Changing this profile does not migrate files. Saturn validates and indexes the target as an independent file set.</p><button className="button settings-action" type="button" disabled={pending || !reauthed} onClick={openStorageDialog}>Configure storage</button></section>
        <section className="settings-subgroup"><h3>Drop upload buffer</h3><p>Public, in-house and owner uploads share one maximum file size. Drop uploads are accepted locally, verified and drained to Storage Box by bounded workers.</p><StatusRow label="Local upload buffer" state={dropBuffer?.capacity?.state === "available" || dropBuffer?.capacity?.state === "warning" ? "ready" : "unavailable"} detail={dropBuffer?.capacity === undefined ? "Unavailable" : `${dropBuffer.capacity.state} · ${formatBytes(dropBuffer.capacity.reservedBytes)} / ${formatBytes(dropBuffer.capacity.maxBytes)}`} /><form className="upload-limits-form" onSubmit={(event) => void applyUploadLimits(event)}><label>Buffer capacity, GiB<input aria-label="Upload buffer capacity, GiB" type="number" min={1} max={8_192} step={1} value={uploadBufferDraft} onChange={(event) => setUploadBufferDraft(Number(event.target.value))} required /></label><label>Maximum file size, GiB<input aria-label="Maximum upload file size, GiB" type="number" min={1} max={4_096} step={1} value={maximumUploadFileDraft} onChange={(event) => setMaximumUploadFileDraft(Number(event.target.value))} required /></label><button className="button" type="submit" disabled={pending || (uploadBufferDraft === preferences.uploadBufferGiB && maximumUploadFileDraft === preferences.maximumUploadFileGiB)}>Save upload limits</button></form><p className="setting-meta">Maximum file size must remain at or below 90% of buffer capacity. New limits apply without restarting Saturn.{dropBuffer === undefined ? " Runtime status is unavailable." : ` ${String(dropBuffer.workers)} workers · ${String(Math.round(dropBuffer.sessionTtlMs / 60_000))} min absolute session · ${formatBytes(dropBuffer.maximumFileBytes)} maximum file.`}</p><button className="button settings-action" type="button" onClick={() => void loadDropBuffer()} disabled={pending}>Refresh buffer</button></section>
        <section className="settings-subgroup"><h3>Trash retention</h3><p>Sets how many days a newly trashed file or folder remains recoverable before automatic permanent deletion.</p><form className="reauth-form trash-retention-form" onSubmit={(event) => void applyTrashRetention(event)}><label>Retention period, days<input aria-label="Trash retention, days" type="number" min={1} max={365} step={1} value={trashRetentionDraft} onChange={(event) => setTrashRetentionDraft(Number(event.target.value))} required /></label><button className="button" type="submit" disabled={pending || trashRetentionDraft === preferences.trashRetentionDays}>Save retention</button></form><p className="setting-meta">Applies to items moved to Trash after saving. Existing deletion deadlines remain unchanged.</p></section>
        <section className="settings-subgroup settings-group--danger"><h3>Sessions</h3><p>Revoke every active browser session, including this one. Stored files remain unchanged.</p><button className="button button--danger settings-action" type="button" disabled={!reauthed || pending} onClick={() => setRevokeDialog(true)}>Revoke all sessions</button></section>
      </div></details>
    </div>,
    backup: <div className="settings-groups backup-content">
      <section className="settings-group"><h3>System snapshot</h3><p>Logical snapshots contain authoritative state and personalization, but no plaintext passwords or service tokens.</p><button className="button settings-action" type="button" disabled={pending || !recovery?.exportEnabled} title={recovery?.reason} onClick={() => void createRecoverySnapshot()}>{pending ? "Creating snapshot…" : "Create and download snapshot"}</button></section>
      <section className="settings-group"><h3>Restore snapshot</h3><p>Restore validates the complete archive before replacement and rolls back if post-restore health fails.</p><button className="button settings-action" type="button" disabled={pending || !recovery?.restoreEnabled} title={recovery?.reason} onClick={openRestore}>Browse local snapshot archive</button></section>
      <section className="settings-group"><h3>Automatic pipelines</h3><p>Schedules, remote runs and Neptune fleet status are managed only from Synchronization.</p><StatusRow label="Local Neptune agent:" state={neptune?.linked ? "ready" : "unavailable"} detail={neptune?.linked ? "Linked to Saturn" : neptune?.installed ? "Detected · not linked" : "Not installed"} />{neptune?.installed && !neptune.linked ? <button className="button settings-action" type="button" disabled={pending || !reauthed || updates?.updater.state !== "ready"} onClick={() => setNeptuneDialog(true)}>Initialize Neptune</button> : neptune?.linked ? <a className="button settings-action" href="/synchronization">Open Synchronization</a> : null}</section>
    </div>,
    gryphon: <div className="settings-groups bot-connection-groups">
      <section className="settings-group"><h3>Gryphon bot binding</h3><p>Gryphon owns the Telegram connection, service receives only service-scoped commands.</p><StatusRow label="Local Gryphon agent:" state={gryphon === undefined ? "unavailable" : "ready"} detail={gryphon === undefined ? "Service Unavailable" : "Service Reachability"} />{gryphon?.connected === true && gryphon.bot !== null ? <p className="bot-connection-selected">Connected bot: <strong>{gryphon.bot.username === undefined ? gryphon.bot.alias : `@${gryphon.bot.username}`}</strong></p> : null}{gryphon?.connected === true && gryphon.binding === null ? <button className="button button--primary settings-action bot-connection-action" type="button" disabled={pending || !reauthed} onClick={() => void issueGryphonLink()}>{pending ? "Creating…" : "Initialize bot"}</button> : null}<button className="button settings-action bot-connection-action" type="button" disabled={pending || gryphon === undefined} onClick={() => void (gryphon?.connected === true ? disconnectGryphon() : openGryphonConnection())}>{pending ? "Working…" : gryphon?.connected === true ? "Unlink Saturn function" : "Link Saturn function"}</button>{gryphon?.binding !== null && gryphon?.binding !== undefined ? <p className="bot-connection-selected">Telegram account linked.</p> : null}</section>
      <section className="settings-group"><h3>Gryphon version</h3><p>Current installed version: <strong>{gryphon?.version ?? "unavailable"}</strong>{gryphonRelease?.available_version === undefined ? "" : ` · latest ${gryphonRelease.available_version}`}</p><button className="button settings-action" type="button" disabled={pending || gryphon === undefined} onClick={() => void checkGryphonUpdate()}>Check Gryphon for updates</button>{gryphonRelease?.update_available === true && gryphonRelease.available_version !== undefined ? <button className="button button--primary settings-action" type="button" disabled={pending} onClick={() => void installGryphonUpdate()}>Install Gryphon {gryphonRelease.available_version}</button> : null}</section>
    </div>,
    updates: <div className="settings-groups updates-content"><section className="settings-group update-pipeline-group"><h3>Update pipeline</h3><p>Release discovery comes from Kernel Register; replacement and rollback are performed by the local Updater.</p><p>Current installed version: <strong className="accent-text">v{updates?.installedVersion ?? "unknown"}</strong></p><div className="settings-status-stack"><StatusRow label="Local Updater agent:" state={updates === undefined ? "busy" : updates.updater.state} detail={updates === undefined ? "Checking" : updates.updater.state === "ready" ? "Service Reachability" : updates.updater.reason ?? "Service Unavailable"} /><StatusRow label="Kernel Register:" state={updates === undefined ? "busy" : updates.registry.state} detail={updates === undefined ? "Checking" : updates.registry.state === "ready" ? "Service Reachability" : updates.registry.reason ?? "Service Unavailable"} /></div><button className="button settings-action update-check-action" type="button" onClick={() => { setUpdateDialog(true); void loadUpdates(); }}>Check for updates</button></section><section className="settings-group updater-version-group"><h3>Updater version</h3><p>Current installed version: {updates?.updater.version ?? "unavailable"}</p><button className="button settings-action" type="button" disabled={pending} onClick={() => void loadUpdates().then(() => addNotice("info", "Updater version status refreshed."))}>Check Updater for updates</button></section></div>,
    logs: <div className="settings-groups"><section className="settings-group logs-group"><div className="logs-actions"><p>Compact ordered audit stream. The browser keeps at most 200 visible events.</p><a className="button" href="/api/v1/activity/export?limit=10000" download>Download archived logs</a></div><div className="log-table" role="log" aria-live="polite"><div className="log-row log-row--head"><span>TYPE</span><span>BODY</span><span>TIME</span></div>{events.length === 0 ? <p className="empty-state">No retained events are available.</p> : events.map((item) => <div className="log-row" key={item.id}><strong className={item.outcome === "success" ? "log-type--success" : "log-type--failure"}>/{item.outcome.toUpperCase()}</strong><span title={item.correlationId}>{item.action}{item.resourceId === undefined ? "" : ` · ${item.resourceId}`}</span><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString("ru-RU")}</time></div>)}</div><button className="button settings-action" type="button" disabled={events.length === 0} onClick={() => { const before = events.at(-1)?.sequence; if (before !== undefined) void api.activity(before, 100).then((older) => setEvents((current) => [...current, ...older].slice(0, 200))); }}>Load older</button></section></div>,
  };

  return <section className="workspace settings" aria-labelledby="settings-title">
    <PageHeader title="settings" id="settings-title" />
    <div className="card-grid card-grid--settings">
      {preferences.settingsOrder.map((id, index) => <UniversalCard ordinal={index + 1} title={SETTINGS_CARD_TITLES[id]} className={`settings-card settings-card--${id}${dropCard === id ? " universal-card--drop-target" : ""}`} draggable handleLabel={`Reorder ${id} settings card`} onHandleKeyDown={(event) => moveSettingsCardByKeyboard(event, id)} onDragStart={(event) => { setDraggingCard(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); }} onDragOver={(event) => { if (draggingCard !== undefined && draggingCard !== id) { event.preventDefault(); setDropCard(id); } }} onDrop={(event) => { event.preventDefault(); if (draggingCard !== undefined) moveSettingsCard(draggingCard, id); setDraggingCard(undefined); setDropCard(undefined); }} onDragEnd={() => { setDraggingCard(undefined); setDropCard(undefined); }} key={id}>{cards[id]}</UniversalCard>)}
    </div>
    {neptuneDialog ? <Dialog title="Initialize Neptune" description="Paste a one-time Linux pipeline code created in Synchronization. It is sent directly to the local Updater and is never stored by Saturn." onClose={() => { if (!pending) { setNeptuneDialog(false); setNeptuneCode(""); } }} dismissible={!pending}><form className="dialog-form" onSubmit={(event) => void initializeNeptune(event)}><label>Saturn setup code<input value={neptuneCode} minLength={32} maxLength={32} autoComplete="off" onChange={(event) => setNeptuneCode(event.target.value.trim())} required /></label><div className="dialog__actions"><button className="button" type="button" disabled={pending} onClick={() => { setNeptuneDialog(false); setNeptuneCode(""); }}>Cancel</button><button className="button button--primary" type="submit" disabled={pending || neptuneCode.length !== 32}>{pending ? "Starting…" : "Initialize"}</button></div></form></Dialog> : null}
    {gryphonChallenge ? <Dialog title="Link Telegram account" description={`Send this command to ${gryphonChallenge.botUsername === undefined ? "the connected bot" : `@${gryphonChallenge.botUsername}`}. It is single-use and expires ${new Date(gryphonChallenge.expiresAt).toLocaleString()}.`} onClose={() => setGryphonChallenge(undefined)}><div className="dialog-form"><div className="one-time-code" role="status"><strong>{gryphonChallenge.command}</strong></div><div className="dialog__actions"><button className="button" type="button" onClick={() => void navigator.clipboard.writeText(gryphonChallenge.command).then(() => addNotice("success", "Command copied."))}>Copy command</button><button className="button button--primary" type="button" onClick={() => setGryphonChallenge(undefined)}>Done</button></div></div></Dialog> : null}
    {accessKeyDialog ? <Dialog title="Change Access Key" description="Enter the current key, then the replacement twice. No field is preloaded." onClose={() => { setAccessKeyDialog(false); setAccessKeyChange({ currentAccessKey: "", newAccessKey: "", confirmation: "" }); }}><form className="dialog-form" onSubmit={(event) => void changeOwnerAccessKey(event)}><label>Current Access Key<input type="password" autoComplete="current-password" value={accessKeyChange.currentAccessKey} onChange={(event) => setAccessKeyChange({ ...accessKeyChange, currentAccessKey: event.target.value })} required /></label><label>New Access Key<input type="password" autoComplete="new-password" minLength={32} value={accessKeyChange.newAccessKey} onChange={(event) => setAccessKeyChange({ ...accessKeyChange, newAccessKey: event.target.value })} required /></label><label>Confirm new Access Key<input type="password" autoComplete="new-password" minLength={32} value={accessKeyChange.confirmation} onChange={(event) => setAccessKeyChange({ ...accessKeyChange, confirmation: event.target.value })} required /></label><div className="dialog__actions"><button className="button" type="button" onClick={() => { setAccessKeyDialog(false); setAccessKeyChange({ currentAccessKey: "", newAccessKey: "", confirmation: "" }); }}>Cancel</button><button className="button button--primary" type="submit" disabled={pending || accessKeyChange.newAccessKey.length < 32 || accessKeyChange.confirmation !== accessKeyChange.newAccessKey}>Change Access Key</button></div></form></Dialog> : null}
    {kernelTokenDialog ? <Dialog title="Change Kernel token" description="The replacement is write-only and activates only after authenticated validation." onClose={() => { setKernelTokenDialog(false); setKernelToken(""); }}><form className="dialog-form" onSubmit={(event) => void rotateKernelToken(event)}><label>Replacement Kernel token<input type="password" autoComplete="new-password" value={kernelToken} minLength={32} onChange={(event) => setKernelToken(event.target.value)} required /></label><div className="dialog__actions"><button className="button" type="button" onClick={() => { setKernelTokenDialog(false); setKernelToken(""); }}>Cancel</button><button className="button button--primary" type="submit" disabled={pending || kernelToken.length < 32}>Validate and rotate</button></div></form></Dialog> : null}
    {gryphonConnectionDialog ? <Dialog title="Link Saturn function" description="Select a Telegram bot already connected through the Gryphon CLI." onClose={() => setGryphonConnectionDialog(false)} dismissible={!pending}><div className="bot-picker"><div className="bot-picker-list">{gryphonBots.length === 0 ? <p>No bots are connected. Add one with <code>gryphon bot connect</code>.</p> : gryphonBots.map((bot) => <label key={bot.id} className={bot.state === "ready" ? "" : "is-disabled"}><input type="radio" name="saturn-gryphon-bot" value={bot.id} checked={gryphonBotId === bot.id} disabled={bot.state !== "ready" || pending} onChange={() => setGryphonBotId(bot.id)} /><span><strong>{bot.username === undefined ? bot.alias : `@${bot.username}`}</strong><small>{bot.alias} · {bot.state}</small></span></label>)}</div><div className="dialog__actions"><button className="button" type="button" disabled={pending} onClick={() => setGryphonConnectionDialog(false)}>Cancel</button><button className="button button--primary" type="button" disabled={pending || gryphonBotId === ""} onClick={() => void connectGryphon()}>{pending ? "Linking…" : "Link function"}</button></div></div></Dialog> : null}
    {storageDialog ? <Dialog title="Configure storage" description="Connect an independent SFTP file set. No files are copied from or deleted in the current storage." dismissible={false} onClose={() => undefined}>
      <form className="dialog-form storage-dialog" onSubmit={(event) => { event.preventDefault(); void testStorage(); }} autoComplete="off">
        <div className="storage-dialog__grid">
          <label>Host<input value={storageDraft.host} maxLength={255} onChange={(event) => updateStorageDraft({ host: event.target.value })} required /></label>
          <label>Port<input type="number" min={1} max={65_535} value={storageDraft.port} onChange={(event) => updateStorageDraft({ port: Number(event.target.value) })} required /></label>
          <label>User<input value={storageDraft.username} maxLength={255} onChange={(event) => updateStorageDraft({ username: event.target.value })} required /></label>
          <label>Root<input value={storageDraft.root} maxLength={1_024} onChange={(event) => updateStorageDraft({ root: event.target.value })} required /></label>
          <label className="storage-dialog__wide">Pinned host fingerprint<input value={storageDraft.hostFingerprint} placeholder="SHA256:…" pattern="SHA256:[A-Za-z0-9+/]{43}=?" onChange={(event) => updateStorageDraft({ hostFingerprint: event.target.value })} required /></label>
          <label>Authentication<select value={storageDraft.authMode} onChange={(event) => updateStorageDraft({ authMode: event.target.value as StorageConnectionInput["authMode"], credential: "" })}><option value="password_file">Password</option><option value="private_key_file">Private key</option></select></label>
          <label className="storage-dialog__wide">{storageDraft.authMode === "password_file" ? "New storage password" : "Private key PEM"}{storageDraft.authMode === "password_file" ? <input type="password" autoComplete="new-password" value={storageDraft.credential} onChange={(event) => updateStorageDraft({ credential: event.target.value })} required /> : <textarea autoComplete="off" rows={6} value={storageDraft.credential} onChange={(event) => updateStorageDraft({ credential: event.target.value })} required />}</label>
        </div>
        <p className="setting-meta">The credential begins empty, is sent only for this action and is never readable through the API.</p>
        {storageStage === "testing" ? <p role="status" className="accent-text">Testing pinned host identity, authentication and root…</p> : null}
        {storageStage === "tested" ? <p role="status" className="storage-test-success">Connection verified. Changing any field requires another test.</p> : null}
        <label className="storage-switch-confirm"><input type="checkbox" checked={storageConfirmed} onChange={(event) => setStorageConfirmed(event.target.checked)} />Use the target as an independent file set. Rebuild the active index, revoke shares and devices, clear pending transfers, and migrate zero file bytes.</label>
        <div className="dialog__actions"><button className="button" type="button" disabled={pending} onClick={() => { setStorageDialog(false); setStorageDraft((current) => ({ ...current, credential: "" })); setStorageTested(false); setStorageConfirmed(false); }}>Cancel and discard credential</button><button className="button" type="submit" disabled={pending || !storageDraft.credential}>{storageStage === "testing" ? "Testing…" : "Test connection"}</button><button className="button button--danger" type="button" disabled={pending || !storageTested || !storageConfirmed} onClick={() => void switchStorage()}>{storageStage === "switching" ? "Indexing and switching…" : "Switch without migration"}</button></div>
      </form>
    </Dialog> : null}
    {restoreDialog ? <Dialog title="Restore snapshot" description="Select a local Saturn ZIP. The complete archive is bounded and validated before replacement can begin." dismissible={["idle", "error", "complete"].includes(restoreStage)} onClose={() => { if (["idle", "error", "complete"].includes(restoreStage)) void discardRestore(); }}>
      <div className="restore-workflow" aria-live="polite">
        {restoreStage === "idle" ? <><p>No file has been selected. The operating-system picker opens from the control below.</p><label className="button restore-file-button">Choose snapshot<input ref={restoreInput} type="file" accept=".zip,application/zip" onChange={(event) => void chooseRestore(event.target.files?.[0])} /></label></> : null}
        {["uploading", "validating"].includes(restoreStage) ? <div className="restore-progress"><p>{restoreStage === "uploading" ? `Uploading protected local copy · ${(restoreProgress * 100).toFixed(1)}%` : "Validating manifest, bounds and every member checksum…"}</p><progress aria-label="Restore archive preparation" max={1} value={restoreStage === "validating" ? 1 : restoreProgress} /></div> : null}
        {restoreStage === "ready" && restoreCandidate !== undefined ? <>
          <dl className="restore-metadata"><div><dt>File</dt><dd>{restoreCandidate.filename}</dd></div><div><dt>Size</dt><dd>{formatBytes(restoreCandidate.archiveBytes)}</dd></div><div><dt>Format</dt><dd>{restoreCandidate.schema}</dd></div><div><dt>Created</dt><dd>{new Date(restoreCandidate.createdAt).toLocaleString("ru-RU")}</dd></div><div><dt>Members</dt><dd>{restoreCandidate.memberCount}</dd></div><div><dt>Digest</dt><dd title={restoreCandidate.archiveSha256}>{restoreCandidate.archiveSha256.slice(0, 16)}…</dd></div></dl>
          <label className="restore-confirm"><input type="checkbox" checked={restoreConfirmed} onChange={(event) => setRestoreConfirmed(event.target.checked)} />Replace Saturn control-plane state with this snapshot. Current state is first saved to a verified pre-restore archive; user-file bytes in Storage Box are not replaced.</label>
          <div className="dialog__actions"><button className="button" type="button" onClick={() => void discardRestore()}>Discard selected archive</button><button className="button button--danger" type="button" disabled={!restoreConfirmed} onClick={() => void applyRestore()}>Restore and replace</button></div>
        </> : null}
        {restoreStage === "applying" ? <div className="restore-progress"><p>Pre-restore snapshot → write barrier → transactional database restore → migrations → health verification.</p><progress aria-label="Restore in progress" /></div> : null}
        {restoreStage === "error" ? <><p className="restore-error" role="alert">{restoreError}</p><div className="dialog__actions"><button className="button" type="button" onClick={() => void discardRestore()}>Close</button><label className="button restore-file-button">Choose another snapshot<input ref={restoreInput} type="file" accept=".zip,application/zip" onChange={(event) => void chooseRestore(event.target.files?.[0])} /></label></div></> : null}
        {restoreStage === "complete" && restoreResult !== undefined ? <><p className="restore-success" role="status">Restore complete. Database invariants passed in {restoreResult.measuredRtoMs} ms.</p><dl className="restore-metadata">{Object.entries(restoreResult.verification).map(([name, count]) => <div key={name}><dt>{name}</dt><dd>{count}</dd></div>)}</dl><p className="muted">Owner browser sessions are deliberately absent from snapshots. Sign in again to continue against the restored state.</p><div className="dialog__actions"><button className="button button--primary" type="button" onClick={onAnonymous}>Return to login</button></div></> : null}
      </div>
    </Dialog> : null}
    {updateDialog ? <Dialog title="Check for updates" description="Discovery never starts installation." onClose={() => setUpdateDialog(false)}><div className="update-discovery"><p>Installed: <strong className="accent-text">v{updates?.installedVersion ?? "unknown"}</strong></p><StatusRow label="Local updater agent" state={updates?.updater.state ?? "unavailable"} detail={updates?.updater.reason} /><StatusRow label="Approved registry" state={updates?.registry.state ?? "unavailable"} detail={updates?.registry.reason} />{updates?.discoveryEnabled ? <p>Discovery is ready.</p> : <p className="muted">Discovery is unavailable until both trusted dependencies are configured. No update has been started.</p>}</div></Dialog> : null}
    {revokeDialog ? <ConfirmDialog title="Revoke all owner sessions" description="Every browser session is invalidated server-side. Files and storage credentials are unchanged." confirmLabel="Revoke sessions" danger pending={pending} onConfirm={() => void revoke()} onClose={() => setRevokeDialog(false)} /> : null}
  </section>;
}

function SidebarBrand() {
  return <div className="sidebar__brand"><img className="sidebar__planet" src={saturnPlanet} alt="" aria-hidden="true" /><strong>saturn</strong></div>;
}

function AuthenticatedApp({ health, onAnonymous }: { readonly health: GatewayHealth; readonly onAnonymous: () => void }) {
  const [route, setRoute] = useState<OwnerRoute>(() => ownerRouteFromPathname(window.location.pathname));
  const [mobileMenu, setMobileMenu] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches);
  const [sidebarReveal, setSidebarReveal] = useState(false);
  const [dragging, setDragging] = useState<PrimaryViewName | undefined>();
  const [dropTarget, setDropTarget] = useState<{ readonly id: PrimaryViewName; readonly edge: "before" | "after" } | undefined>();
  const [navigationSaving, setNavigationSaving] = useState(false);
  const [navigationAnnouncement, setNavigationAnnouncement] = useState("");
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const [preferences, setPreferences] = useState<Omit<OwnerPreferences, "updatedAt">>(defaultPreferences);
  const [shareCapabilities, setShareCapabilities] = useState<Readonly<Record<string, string>>>({});
  const quickUpload = useRef<HTMLInputElement>(null);
  const mobileMenuButton = useRef<HTMLButtonElement>(null);
  const [quickPending, setQuickPending] = useState(false);
  const addNotice = (kind: Notice["kind"], message: string) => {
    const id = crypto.randomUUID();
    setNotices((current) => [...current.slice(-4), { id, kind, message }]);
    if (kind !== "error") window.setTimeout(() => setNotices((current) => current.filter((item) => item.id !== id)), 4_500);
  };
  useEffect(() => {
    void api.preferences().then((value) => setPreferences(ownerPreferences(value))).catch(() => undefined);
  }, []);
  useEffect(() => {
    const canonical = ownerRouteUrl(ownerRouteFromPathname(window.location.pathname));
    if ((window.location.pathname.replace(/\/+$/, "") || "/") !== canonical) window.history.replaceState({}, "", canonical);
    const restoreRoute = () => setRoute(ownerRouteFromPathname(window.location.pathname));
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 720px)");
    const update = () => { setNarrowViewport(query.matches); if (!query.matches) setMobileMenu(false); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!mobileMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileMenu(false);
      mobileMenuButton.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenu]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent", preferences.accentColor);
  }, [preferences]);
  const commitRoute = useCallback((next: OwnerRoute, replace = false) => {
    window.history[replace ? "replaceState" : "pushState"]({}, "", ownerRouteUrl(next));
    setRoute(next);
  }, []);
  const navigate = (next: ViewName) => {
    commitRoute({ view: next, folderSegments: [] });
    setMobileMenu(false);
  };
  const navigateFilesPath = useCallback((folderSegments: readonly string[], replace = false) => {
    commitRoute({ view: "files", folderSegments }, replace);
  }, [commitRoute]);
  const navigateInboxPath = useCallback((folderSegments: readonly string[], replace = false) => {
    commitRoute({ view: "inbox", folderSegments }, replace);
  }, [commitRoute]);
  const rememberShareCapability = useCallback((id: string, url: string) => {
    setShareCapabilities((current) => ({ ...current, [id]: url }));
  }, []);
  const forgetShareCapability = useCallback((id: string) => {
    setShareCapabilities((current) => Object.fromEntries(Object.entries(current).filter(([shareId]) => shareId !== id)));
  }, []);
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
  const persistNavigationOrder = async (nextOrder: readonly PrimaryViewName[]) => {
    if (navigationSaving || nextOrder.every((item, index) => preferences.navigationOrder[index] === item)) return;
    const previous = preferences;
    const candidate = { ...preferences, navigationOrder: nextOrder };
    setPreferences(candidate);
    setNavigationSaving(true);
    try {
      const saved = await api.updatePreferences(candidate);
      setPreferences(ownerPreferences(saved));
      setNavigationAnnouncement(`Navigation order updated. ${NAV_ITEMS[nextOrder[0] ?? "files"].label} is first.`);
    } catch {
      setPreferences(previous);
      addNotice("error", "Navigation order could not be saved.");
    } finally {
      setNavigationSaving(false);
    }
  };
  const reorderNavigation = (source: PrimaryViewName, target: PrimaryViewName, edge: "before" | "after") => {
    if (source === target) return;
    const next = preferences.navigationOrder.filter((item) => item !== source) as PrimaryViewName[];
    const targetIndex = next.indexOf(target);
    next.splice(targetIndex + (edge === "after" ? 1 : 0), 0, source);
    void persistNavigationOrder(next);
  };
  const moveNavigationByKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, item: PrimaryViewName) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const current = preferences.navigationOrder.indexOf(item);
    const nextIndex = current + (event.key === "ArrowUp" ? -1 : 1);
    if (nextIndex < 0 || nextIndex >= preferences.navigationOrder.length) return;
    const target = preferences.navigationOrder[nextIndex];
    if (target !== undefined) reorderNavigation(item, target, event.key === "ArrowUp" ? "before" : "after");
  };
  const sidebarVisible = narrowViewport
    ? mobileMenu
    : preferences.sidebarMode === "fixed" || sidebarReveal;
  return (
    <div className={`app-shell ${preferences.sidebarMode === "auto-hide" ? "app-shell--auto-hide" : ""}`}>
      <button ref={mobileMenuButton} className="mobile-menu-button" type="button" onClick={() => setMobileMenu((value) => !value)} aria-expanded={mobileMenu} aria-controls="primary-navigation"><span aria-hidden="true">☰</span> Menu</button>
      <button className="sidebar-activation-strip" type="button" aria-label="Reveal navigation" onMouseEnter={() => setSidebarReveal(true)} onFocus={() => setSidebarReveal(true)} onClick={() => setSidebarReveal(true)} />
      {mobileMenu ? <button className="sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => { setMobileMenu(false); mobileMenuButton.current?.focus(); }} /> : null}
      <aside
        className={`sidebar ${mobileMenu ? "sidebar--open" : ""} ${sidebarReveal ? "sidebar--revealed" : ""}`}
        id="primary-navigation"
        aria-hidden={!sidebarVisible}
        inert={!sidebarVisible ? true : undefined}
        onMouseEnter={() => setSidebarReveal(true)}
        onMouseLeave={() => setSidebarReveal(false)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSidebarReveal(false); }}
      >
        <SidebarBrand />
        <nav aria-label="Primary">
          {preferences.navigationOrder.map((id) => {
            const item = NAV_ITEMS[id];
            const targetClass = dropTarget?.id === id ? ` nav-item--drop-${dropTarget.edge}` : "";
            return <button
              type="button"
              aria-label={item.label}
              aria-current={route.view === id ? "page" : undefined}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              className={`${route.view === id ? "nav-item nav-item--active" : "nav-item"}${targetClass}`}
              draggable={!navigationSaving}
              key={id}
              title="Drag to reorder · Alt+↑/↓"
              onClick={() => navigate(id)}
              onKeyDown={(event) => moveNavigationByKeyboard(event, id)}
              onDragStart={(event: DragEvent<HTMLButtonElement>) => { setDragging(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); }}
              onDragOver={(event: DragEvent<HTMLButtonElement>) => { if (dragging === undefined || dragging === id) return; event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); setDropTarget({ id, edge: event.clientY < box.top + box.height / 2 ? "before" : "after" }); }}
              onDrop={(event: DragEvent<HTMLButtonElement>) => { event.preventDefault(); if (dragging !== undefined && dropTarget !== undefined) reorderNavigation(dragging, dropTarget.id, dropTarget.edge); setDragging(undefined); setDropTarget(undefined); }}
              onDragEnd={() => { setDragging(undefined); setDropTarget(undefined); }}
            ><span className="nav-item__label">{item.label}</span><span className="nav-item__ordinal" aria-hidden="true">{item.ordinal}</span></button>;
          })}
        </nav>
        <p className="sr-only" aria-live="polite">{navigationAnnouncement}</p>
        <div className="sidebar__bottom"><button type="button" aria-current={route.view === "documentation" ? "page" : undefined} onClick={() => navigate("documentation")}>Documentation</button><button type="button" onClick={() => void logout()}>Logout</button></div>
      </aside>
      <main className="content" id="main-content">
        {route.view !== "documentation" ? null : <div className="global-actions"><button className="button button--primary" type="button" disabled={quickPending} onClick={() => quickUpload.current?.click()}>{quickPending ? "Uploading…" : "Quick upload"}</button><input ref={quickUpload} aria-label="Choose files for quick upload" className="visually-hidden-input" type="file" multiple onChange={(event) => void runQuickUpload([...event.target.files ?? []])} /></div>}
        {route.view === "dashboard" ? <DashboardView storageHealth={health.storage} preferences={preferences} setPreferences={setPreferences} addNotice={addNotice} /> : null}
        {route.view === "files" ? <FilesView initialFolderId={ROOT_RESOURCE_ID} title="Storage" routeSegments={route.folderSegments} onPathChange={navigateFilesPath} shareCapabilities={shareCapabilities} onShareCapabilityCreated={rememberShareCapability} onShareCapabilityRevoked={forgetShareCapability} addNotice={addNotice} onUnauthorized={onAnonymous} /> : null}
        {route.view === "inbox" ? <InHouseDropView health={health.gateway} routeSegments={route.folderSegments} onPathChange={navigateInboxPath} shareCapabilities={shareCapabilities} onShareCapabilityCreated={rememberShareCapability} onShareCapabilityRevoked={forgetShareCapability} addNotice={addNotice} onUnauthorized={onAnonymous} /> : null}
        {route.view === "shared" ? <SharedView shareCapabilities={shareCapabilities} onShareCapabilityRevoked={forgetShareCapability} addNotice={addNotice} onAnonymous={onAnonymous} /> : null}
        {route.view === "synchronization" ? <SynchronizationView addNotice={addNotice} /> : null}
        {route.view === "trash" ? <TrashView retentionDays={preferences.trashRetentionDays} addNotice={addNotice} onUnauthorized={onAnonymous} /> : null}
        {route.view === "settings" ? <SettingsView preferences={preferences} setPreferences={setPreferences} addNotice={addNotice} onAnonymous={onAnonymous} /> : null}
        {route.view === "documentation" ? <DocumentationView /> : null}
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
  if (auth === "anonymous") return <LoginView health={health.gateway} onAuthenticated={() => setAuth("authenticated")} />;
  return <AuthenticatedApp health={health} onAnonymous={() => setAuth("anonymous")} />;
}

function DropApp() {
  return <DropView health={useGatewayHealth().gateway} />;
}

export function App() {
  const route = window.location.pathname.replace(/\/+$/, "");
  if (route === "/drop") return <DropApp />;
  const share = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(route);
  return share?.[1] === undefined ? <OwnerApp /> : <PublicShareView token={share[1]} />;
}
