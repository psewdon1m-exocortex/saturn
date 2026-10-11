import type { MouseEvent, ReactNode } from "react";
import { downloadUrl, folderDownloadUrl } from "./api.js";
import type { Resource, ShareInfo } from "./types.js";

type FileKind = "folder" | "image" | "video" | "audio" | "pdf" | "markdown" | "document" | "archive" | "file";

// Presentation only: FilesView owns selection, permissions and every mutation.
export function StorageNewGrid({ items, selected, loading, error, emptyMessage, shares, pending, kind, icon, size, date, onSelect, canPreview, onOpen, onMenu, onKeyboardMenu, onShare, onRetry, onDelete }: {
  readonly items: readonly Resource[];
  readonly selected: ReadonlySet<string>;
  readonly loading: boolean;
  readonly error: string;
  readonly emptyMessage: string;
  readonly shares: ReadonlyMap<string, ShareInfo>;
  readonly pending: boolean;
  readonly kind: (resource: Resource) => FileKind;
  readonly icon: (kind: FileKind) => ReactNode;
  readonly size: (bytes: number) => string;
  readonly date: (value: string) => string;
  readonly onSelect: (resource: Resource, additive: boolean, range: boolean) => void;
  readonly canPreview: (resource: Resource) => boolean;
  readonly onOpen: (resource: Resource) => void;
  readonly onMenu: (event: MouseEvent, resource?: Resource) => void;
  readonly onKeyboardMenu: (resource: Resource, x: number, y: number) => void;
  readonly onShare: (share: ShareInfo) => void;
  readonly onRetry: () => void;
  readonly onDelete: () => void;
}) {
  return <div className="storage-new-grid" aria-label="Stored files and folders" aria-busy={loading} tabIndex={0} onContextMenu={(event) => onMenu(event)} onKeyDown={(event) => { if (event.key === "Delete") onDelete(); }}>
    {loading ? <p className="storage-new-empty" role="status">Loading folder…</p> : error ? <div className="storage-new-empty" role="alert"><p>{error}</p><button type="button" onClick={onRetry}>Try again</button></div> : items.length === 0 ? <p className="storage-new-empty">{emptyMessage}</p> : items.map((item) => {
      const fileKind = kind(item);
      const share = shares.get(item.id);
      const action = item.type === "folder" ? "Open folder" : canPreview(item) ? "Preview" : "Download";
      return <article key={item.id} className={`storage-new-file${selected.has(item.id) ? " storage-new-file--selected" : ""}`} aria-label={item.name} tabIndex={0}
        onClick={(event) => { if ((event.target as HTMLElement).closest("button, input, a, label") === null) onSelect(item, event.ctrlKey || event.metaKey, event.shiftKey); }}
        onDoubleClick={(event) => { if ((event.target as HTMLElement).closest("button, input, a, label") === null) onOpen(item); }}
        onContextMenu={(event) => { event.stopPropagation(); onMenu(event, item); }}
        onKeyDown={(event) => {
          if (event.code === "Space") event.stopPropagation();
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter") { event.preventDefault(); onOpen(item); }
          if (event.code === "Space") { event.preventDefault(); onSelect(item, event.ctrlKey || event.metaKey, event.shiftKey); }
          if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onKeyboardMenu(item, bounds.left + 40, bounds.top + 40);
          }
        }}>
        <div className="storage-new-file__controls"><label><input type="checkbox" aria-label={`Select ${item.name}`} checked={selected.has(item.id)} readOnly onClick={(event) => onSelect(item, true, event.shiftKey)} /></label><button className="storage-new-file__menu" type="button" disabled={pending} aria-label={`Actions for ${item.name}`} onClick={(event) => { if (event.detail === 0) { const bounds = event.currentTarget.getBoundingClientRect(); onKeyboardMenu(item, bounds.left, bounds.bottom); } else onMenu(event, item); }}>···</button></div>
        <button className={`storage-new-file__visual storage-new-file__visual--${fileKind}`} type="button" aria-label={`${action} ${item.name}`} disabled={pending} onClick={() => onOpen(item)}>
          {icon(fileKind)}
          {fileKind === "image" ? <img src={downloadUrl(item.id, true)} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
        </button>
        <div className="storage-new-file__meta"><button className="storage-new-file__name" type="button" onClick={(event) => onSelect(item, event.ctrlKey || event.metaKey, event.shiftKey)}>{item.name}</button><span>{item.type === "folder" ? "Folder" : fileKind === "file" ? "File" : fileKind.toUpperCase()} · {item.type === "folder" && item.sizeBytes === 0 ? "—" : size(item.sizeBytes)}</span><time dateTime={item.updatedAt}>{date(item.updatedAt)}</time></div>
        <div className="storage-new-file__footer">{share === undefined ? <span>Private</span> : <button type="button" onClick={() => onShare(share)} aria-label={`Shared access for ${item.name}`}>Shared ↗</button>}<a href={item.type === "folder" ? folderDownloadUrl(item.id) : downloadUrl(item.id)} onClick={(event) => { event.currentTarget.href = item.type === "folder" ? folderDownloadUrl(item.id) : downloadUrl(item.id); }} aria-label={`Download ${item.name}`}>Download ↓</a></div>
      </article>;
    })}
  </div>;
}
