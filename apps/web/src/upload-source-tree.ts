export type UploadTreeSource = {
  readonly kind: "file";
  readonly name: string;
  readonly getFile: () => Promise<File>;
} | {
  readonly kind: "directory";
  readonly name: string;
  readonly children: () => AsyncIterable<UploadTreeSource>;
};

export interface UploadTreeItem {
  readonly itemId: string;
  readonly parentItemId?: string;
  readonly relativePath: string;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly getFile?: () => Promise<File>;
}

export function validateUploadTreeName(name: string): string {
  if (!name || name !== name.normalize("NFC").trim() || name === "." || name === ".." || name.length > 255
    || /[\\/:*?"<>|\p{Cc}\p{Cs}]/u.test(name) || /%[0-9a-f]{2}/i.test(name) || name.endsWith(".")
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) throw new Error(`Unsupported upload tree name: ${name.slice(0, 80)}`);
  return name;
}

/** Enumerates handles and empty directories, without opening any file bytes.
 * Validate the complete bounded manifest before submitting the first job. */
export async function enumerateUploadTree(roots: readonly UploadTreeSource[], options: {
  readonly signal?: AbortSignal;
  readonly maxItems?: number;
  readonly maxDirectories?: number;
  readonly maxDepth?: number;
  readonly onEnumerated?: (count: number) => void;
} = {}): Promise<readonly UploadTreeItem[]> {
  const limit = options.maxItems ?? 20_000, directoryLimit = options.maxDirectories ?? 10_000, depthLimit = options.maxDepth ?? 64;
  if (![limit, directoryLimit, depthLimit].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid upload tree bound");
  const items: UploadTreeItem[] = [], paths = new Set<string>();
  let directories = 0;
  const visit = async (source: UploadTreeSource, parent: UploadTreeItem | undefined, depth: number): Promise<void> => {
    options.signal?.throwIfAborted();
    if (items.length >= limit || depth > depthLimit) throw new Error("Upload tree exceeds the item or depth limit");
    const name = validateUploadTreeName(source.name), relativePath = parent === undefined ? name : `${parent.relativePath}/${name}`;
    if (new TextEncoder().encode(relativePath).length > 4096) throw new Error("Upload tree path exceeds 4096 bytes");
    const key = relativePath.toLowerCase();
    if (paths.has(key)) throw new Error(`Duplicate or case-colliding upload path: ${relativePath}`);
    paths.add(key);
    if (source.kind === "directory" && ++directories > directoryLimit) throw new Error("Upload tree exceeds the directory limit");
    const item: UploadTreeItem = { itemId: crypto.randomUUID(), ...(parent === undefined ? {} : { parentItemId: parent.itemId }), relativePath, name, kind: source.kind, ...(source.kind === "file" ? { getFile: source.getFile } : {}) };
    items.push(item);
    options.onEnumerated?.(items.length);
    if (items.length % 128 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (source.kind === "directory") for await (const child of source.children()) await visit(child, item, depth + 1);
  };
  for (const source of roots) await visit(source, undefined, 1);
  options.signal?.throwIfAborted();
  return items;
}

interface DirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  readonly entries: () => AsyncIterable<[string, DirectoryHandle | FileHandle]>;
}
interface FileHandle { readonly kind: "file"; readonly name: string; readonly getFile: () => Promise<File> }
function fromHandle(handle: DirectoryHandle | FileHandle): UploadTreeSource {
  return handle.kind === "file" ? { kind: "file", name: handle.name, getFile: () => handle.getFile() }
    : { kind: "directory", name: handle.name, children: async function* () { for await (const [, child] of handle.entries()) yield fromHandle(child); } };
}
export function directoryPickerAvailable(): boolean { return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"; }
export async function chooseUploadDirectory(): Promise<UploadTreeSource> {
  const picker = (window as unknown as { showDirectoryPicker?: (options: { readonly mode: "read" }) => Promise<DirectoryHandle> }).showDirectoryPicker;
  if (picker === undefined) throw new Error("This browser cannot select folders with empty directories. Choose individual files or use a browser with folder access.");
  return fromHandle(await picker.call(window, { mode: "read" }));
}

function fromEntry(entry: FileSystemEntry): UploadTreeSource {
  if (entry.isFile) return { kind: "file", name: entry.name, getFile: () => new Promise((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)) };
  return { kind: "directory", name: entry.name, children: async function* () {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (entries.length === 0) return;
      for (const child of entries) yield fromEntry(child);
    }
  } };
}

/** Capture handles synchronously during the drop gesture, before its access expires. */
export function captureDroppedTree(dataTransfer: DataTransfer): Promise<readonly UploadTreeSource[]> {
  // Bound the root handles before allocating promises or asking the browser to
  // open them. Descendants are bounded separately during lazy enumeration.
  if (dataTransfer.items.length > 20_000 || dataTransfer.files.length > 20_000) return Promise.reject(new Error("Upload tree exceeds the item limit"));
  const sources = [...dataTransfer.items].filter(item => item.kind === "file").map(item => {
    const modern = item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<DirectoryHandle | FileHandle | null> };
    if (modern.getAsFileSystemHandle !== undefined) return modern.getAsFileSystemHandle().then(handle => { if (handle === null) throw new Error("Dropped source is unavailable"); return fromHandle(handle); });
    const entry = (item as { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
    if (entry !== null && entry !== undefined) return Promise.resolve(fromEntry(entry));
    const file = item.getAsFile();
    if (file === null) return Promise.reject(new Error("Dropped folder access is unavailable; choose individual files"));
    return Promise.resolve<UploadTreeSource>({ kind: "file", name: file.name, getFile: () => Promise.resolve(file) });
  });
  if (sources.length === 0) return Promise.resolve([...dataTransfer.files].map(file => ({ kind: "file" as const, name: file.name, getFile: () => Promise.resolve(file) })));
  return Promise.all(sources);
}
