/** Scope algebra only. It neither grants authority nor holds a writer permit.
 * The fixed SQL coordinator resolves current catalog paths and persists the
 * whole set atomically, with backend/producer/publication fencing. */
export type BrowserNamespaceMode = "parent" | "entry" | "subtree";
export interface BrowserNamespaceScope { readonly mode: BrowserNamespaceMode; readonly path: string }
const invalid = (path: string) => path.includes("\\") || Array.from(path).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function checkedPath(path: unknown): string {
  if (typeof path !== "string" || Buffer.byteLength(path, "utf8") > 4096 || invalid(path) || path !== path.normalize("NFC")) throw new Error("namespace_scope_invalid");
  if (path === "") return path;
  const parts = path.split("/");
  if (parts.length > 128 || parts.some(part => !part || part === "." || part === ".." || part.trim() !== part || part.includes(":"))) throw new Error("namespace_scope_invalid");
  return path;
}
/** Called only with paths resolved from the current catalog by trusted SQL.
 * Physical backend case policy is constructor configuration, never a request. */
export function canonicalBrowserNamespaceScopes(input: unknown, caseSensitive: boolean): readonly BrowserNamespaceScope[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 256 || typeof caseSensitive !== "boolean") throw new Error("namespace_scope_invalid");
  const scopes = new Map<string, BrowserNamespaceScope>();
  const candidates: readonly unknown[] = input;
  for (const scope of candidates) {
    if (scope === null || typeof scope !== "object" || !("mode" in scope) || !("path" in scope)) throw new Error("namespace_scope_invalid");
    const requestedMode = scope.mode;
    if (requestedMode !== "parent" && requestedMode !== "entry" && requestedMode !== "subtree") throw new Error("namespace_scope_invalid");
    const path = checkedPath(scope.path), parts = path.split("/");
    const nonAscii = caseSensitive ? -1 : parts.findIndex(part => Array.from(part).some(character => character.charCodeAt(0) > 127));
    // Do not assume JS Unicode lowercase equals a filesystem/SQL collation.
    // Until a shared qualified codec exists, serialize the nearest ASCII
    // ancestor subtree for non-ASCII case-insensitive paths. This may reduce
    // parallelism, but cannot admit aliases under different lock keys.
    const folded = caseSensitive ? path : (nonAscii < 0 ? path : parts.slice(0, nonAscii).join("/")).toLowerCase();
    const mode = nonAscii < 0 ? requestedMode : "subtree";
    const key = `${folded}\0${mode}`;
    scopes.set(key, Object.freeze({ mode, path: folded }));
  }
  // UTF-8 binary order matches a fixed C-collation persistence representation;
  // no locale-dependent ordering that could invert acquisition across workers.
  return Object.freeze([...scopes.values()].sort((a, b) => Buffer.compare(Buffer.from(`${a.path}\0${a.mode}`), Buffer.from(`${b.path}\0${b.mode}`))));
}
function contains(ancestor: string, path: string): boolean { return ancestor === "" || path === ancestor || path.startsWith(`${ancestor}/`); }
/** Both arguments must be canonical under the SAME trusted backend policy. */
export function browserNamespaceScopesConflict(left: readonly BrowserNamespaceScope[], right: readonly BrowserNamespaceScope[]): boolean {
  for (const a of left) for (const b of right) {
    if (a.mode === "parent" && b.mode === "parent") continue;
    if (a.mode === "parent") { if (b.mode === "subtree" ? contains(b.path, a.path) : a.path === b.path) return true; continue; }
    if (b.mode === "parent") { if (a.mode === "subtree" ? contains(a.path, b.path) : a.path === b.path) return true; continue; }
    if (a.mode === "subtree" || b.mode === "subtree") { if (contains(a.path, b.path) || contains(b.path, a.path)) return true; }
    else if (a.path === b.path) return true;
  }
  return false;
}
