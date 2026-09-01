# Stage 12 — Laboratory assets

Status: `COMPLETE`

## Purpose

Expose selected Saturn files to Laboratory through stable Gateway-owned asset
identifiers. Markdown must never contain a Storage Box hostname, SFTP path,
provider URL or temporary share capability. Public delivery is an explicit
classification decision; the system remains private by default.

## State contract

### Entry state

- Stages 0–11 are `COMPLETE`.
- File/resource/version IDs survive rename and move; Range and exact checksums
  are proven through `FileService` and `StorageAdapter`.
- Owner authentication, recent proof, audit, recovery export and public-route
  isolation are operational.
- The unresolved operator decision “public Laboratory traffic” uses the
  recorded default `private`; DEV verification may explicitly enable public
  modes with generated non-sensitive fixtures.

### Intermediate state

- `CLIENT_ACTIVE`: owner provisions a scoped Laboratory service identity; its
  random token is disclosed once and only an HMAC verifier is persisted.
- `ASSET_PRIVATE`: asset points to a stable active file and is readable only by
  an active Laboratory token with the required scope.
- `ASSET_PUBLIC_IMMUTABLE`: asset pins a concrete active file version and can
  be publicly streamed with immutable cache policy. A pinned version is exempt
  from ordinary version purge while the asset is active.
- `ASSET_PUBLIC_ALIAS`: stable asset points to the resource's current version,
  uses ETag revalidation and changes bytes only after a committed overwrite.
- `ASSET_DISABLED`: delivery stops immediately; bytes, resource history and
  audit/recovery evidence remain intact.
- `ASSET_RECLASSIFIED`: transitions between private and public modes require
  recent owner proof, current resource policy validation and audit evidence.

### Exit state

- `/a/{asset_id}/{filename}` contains only Gateway domain, stable asset ID and
  a safe presentation filename; physical rename/move does not break it.
- Immutable assets keep exact version bytes/digest and long cache lifetime;
  mutable aliases track only verified current versions and require revalidation.
- Private assets return indistinguishable denial without a valid scoped token;
  tokens cannot list Drive, read other Gateway APIs or reveal storage paths.
- Public creation is disabled by default and can use only resources explicitly
  classified `public`; Volt/KeePass, trashed/purged and unsafe resources
  cannot be exposed.
- GET/HEAD, single HTTP Range, If-None-Match, ETag, Last-Modified,
  Content-Length, MIME and safe disposition semantics are correct and bounded.
- Gateway returns a context-appropriate escaped Markdown/HTML fragment; it
  never edits Laboratory content or stores credentials in the fragment.
- Binary asset routes emit `X-Robots-Tag: noindex, nofollow`; no indexable HTML
  wrapper or sitemap entry is created until the operator explicitly approves
  an SEO/GEO surface.
- Asset/client metadata and pinned-version references are present in recovery
  exports while token verifiers and transient delivery state are excluded.

## API contract

Owner routes use cookie session + CSRF. Client creation, public exposure,
reclassification, token rotation/revoke and asset disable require recent proof.

```text
POST   /api/v1/laboratory/clients
GET    /api/v1/laboratory/clients
POST   /api/v1/laboratory/clients/{id}/rotate-token
DELETE /api/v1/laboratory/clients/{id}
POST   /api/v1/laboratory/assets
GET    /api/v1/laboratory/assets
GET    /api/v1/laboratory/assets/{id}
PATCH  /api/v1/laboratory/assets/{id}
DELETE /api/v1/laboratory/assets/{id}
GET    /api/v1/laboratory/assets/{id}/fragment
GET    /a/{asset_id}/{filename}
HEAD   /a/{asset_id}/{filename}
```

Private content uses `Authorization: Bearer <laboratory-token>` on `/a/...`.
There is deliberately no token-authenticated asset enumeration or mutation
route. The owner API never returns token verifiers or physical storage paths.

## Mode and cache contract

| Mode | Byte target | Authorization | Cache-Control |
| --- | --- | --- | --- |
| `private` | current verified resource version | scoped Laboratory Bearer token | `private, no-store` |
| `public_immutable` | pinned `file_version_id` | none when global public delivery is enabled | `public, max-age=31536000, immutable` |
| `public_alias` | current verified resource version | none when global public delivery is enabled | `public, max-age=0, must-revalidate` |

All modes use the selected version SHA-256 as a strong ETag. Filename mismatch,
disabled asset, missing version, invalid token, forbidden classification and
trashed/purged resource produce no storage/provider disclosure.

## Safety and limits

- asset label/alt text: NFC, no control characters, bounded length;
- one asset per stable UUIDv7; no resource path in identity;
- Laboratory token: 32 random bytes, base64url, HMAC-SHA-256 verifier, bounded
  rotation overlap and immediate revoke;
- public delivery: separately enabled configuration and bounded concurrent
  streams; proxy/CDN is required before sustained mass traffic;
- Range uses one satisfiable byte interval; multi-range and invalid ranges are
  rejected without opening storage;
- `Content-Disposition` and Markdown/HTML fragments escape CR/LF, quotes,
  brackets and HTML-sensitive characters;
- immutable version references block purge, including after the resource is
  overwritten or moved;
- public/private transitions are never inferred from filename, MIME or folder.

## Verification

1. Migration apply/down/apply, endpoint constraints and recovery allow-list.
2. One-time HMAC client token, scope isolation, rotation overlap and revoke.
3. Private/public feature switch and resource-classification denial matrix.
4. Immutable version pin across overwrite/move and purge-candidate exclusion.
5. Mutable alias ETag/body change only after successful overwrite; rename/move
   leaves the stable URL valid.
6. GET/HEAD/206/304, invalid/multi-range, MIME, length, modification time and
   safe inline/attachment headers.
7. Safe Markdown image/download and HTML video fragments with an adversarial
   filename/label corpus; no provider-specific values.
8. Disabled, trashed, missing-version, wrong-token, expired-overlap and
   cross-API privilege tests with indistinguishable public denial.
9. Bounded concurrent streaming and client-disconnect cleanup; no full local
   copy and no unbounded buffering.
10. Owner browser workflow at desktop/mobile, keyboard table, Axe and browser
    storage checks.
11. Audit actor attribution, portable metadata/log/recovery/built-artifact
    secret scans.

## Rollback

1. Set `LABORATORY_ENABLED=false` and `LABORATORY_PUBLIC_ENABLED=false`; owner
   Files and underlying versions remain available.
2. Revoke every Laboratory client and disable active public assets before
   rolling back API code.
3. Export stable asset/version references and audit evidence before schema
   rollback; never delete file bytes as part of asset rollback.
4. Remove pinned-version purge exemptions only after no active immutable asset
   references that version.

## Implemented result and evidence

- Migration `0011_laboratory_assets` adds scoped client identities, stable
  assets, mode/classification validation and immutable-version references.
- `@saturn/laboratory` implements private, public immutable and public alias
  delivery. Public exposure is disabled by default; Volt and non-public
  resources cannot cross the public boundary.
- Client tokens are 256-bit one-time values. Only peppered HMAC-SHA-256
  verifiers are stored; rotation overlap and immediate revoke are supported,
  and the token cannot access Drive APIs.
- Gateway delivery supports exact stable filenames, GET/HEAD, single Range,
  ETag/304, cache policy, disposition, bounded public streams and noindex
  headers. Immutable pins are excluded from purge while referenced.
- The owner Files and Laboratory views create assets, produce escaped Gateway
  fragments and manage clients. The Vite asset proxy boundary was corrected so
  `/a/` delivery cannot intercept the web application's `/assets/` bundle.
- `pnpm verify:stage:12` passed 12 aggregate checks on 2026-08-26: 76 tests and
  builds, migration rollback, HMAC/scope/rotation, immutable/alias overwrite,
  rename/Range/cache/validator semantics, purge protection, denial matrix,
  recovery and audit/secret scans.
- Browser verification passed at 1440 px and 320 px with zero serious/critical
  Axe findings and no browser storage. One-time token disclosure is verified in
  memory, cleared by reload and absent from the screenshot evidence.
- Machine report: `artifacts/verification/stage-12-laboratory-assets.json`
  (SHA-256 `c43f64c48b75c29449318439a37ece8c2101e43a2e411874cc0979f56a1ab43f`).
