# Stage 9 — Device sync, Mastermind and KeePass

Status: `COMPLETE`

## Purpose

Provide interoperable WebDAV access through Gateway for explicitly scoped
devices while preserving the same resource metadata, versions, audit and
StorageAdapter boundary as the owner UI. Establish the complete Mastermind
Obsidian tree and a separately protected opaque KeePass database workflow.

## State contract

### Entry state

- Stages 0–8 are `COMPLETE`.
- Stable resources, version-safe overwrite, trash/restore, Range, owner recent
  proof and recovery exports are proven.
- The chosen bidirectional roots are `mastermind` and `sync`; `.obsidian` is
  preserved without exclusions.
- KeePass has the canonical logical location
  `/volt/passwords.kdbx` and is never interpreted by Gateway.

### Intermediate state

- `DEVICE_PROVISIONED`: the owner creates a named device with explicit root
  scopes and rights; a 256-bit token is disclosed once and only its
  domain-separated verifier is stored.
- `DAV_AUTHORIZED`: Basic or Bearer credentials resolve to an active device,
  source limits and a canonical path contained by one scope.
- `DAV_READ`: PROPFIND/GET/HEAD expose only scoped logical metadata and stream
  content through FileService with ETag and single Range support.
- `DAV_MUTATION`: PUT/MKCOL/MOVE/COPY/DELETE require the corresponding device
  right, conditional headers and same-scope source/destination checks.
- `SYNC_COMMIT`: an unchanged ETag overwrites through the normal temporary
  upload/verify/version transaction.
- `SYNC_CONFLICT`: stale or concurrently changed state never destroys either
  input; Gateway commits a deterministic conflict copy attributed to the
  device and returns conflict metadata.
- `KEEPASS_PROTECTED`: KDBX is opaque, confidential, never previewed/shared or
  indexed; read/replace requires a dedicated KeePass device scope or owner
  recent proof.
- `DEVICE_REVOKED`: revocation or expiry denies the next request without
  changing any stored resource.

### Exit state

- No device receives Storage Box credentials or can address a storage path.
- A device can access only resources under its stable scoped roots and only
  with its declared rights.
- PROPFIND, GET/HEAD, PUT, MKCOL, MOVE, COPY, DELETE, ETag/If-Match and Range
  interoperate with a real rclone WebDAV client.
- All WebDAV writes traverse FileService and therefore versions, audit and
  reconciliation remain client-independent.
- Concurrent edits retain the current file and a conflict copy; mass deletion
  is bounded and observable.
- Mastermind exports as a normal Obsidian directory including `.obsidian`.
- Current and historical KDBX bytes can be recovered and validated by an
  operator-provided master key; automated tests use a generated fixture only.

## API and protocol contract

```text
POST   /api/v1/devices                    owner + recent proof
GET    /api/v1/devices                    owner
PATCH  /api/v1/devices/{id}               owner + recent proof
DELETE /api/v1/devices/{id}               owner + recent proof

OPTIONS  /dav/*
PROPFIND /dav/*
GET/HEAD /dav/*
PUT      /dav/*
MKCOL    /dav/*
MOVE     /dav/*
COPY     /dav/*
DELETE   /dav/*
```

Device authentication uses `Authorization` and never browser cookies. Paths
are URL-decoded once, normalized as logical names, reject dot segments and are
resolved from scoped stable root IDs. Destination headers must point to the
same Gateway origin and an authorized scope.

## Scope and safety defaults

- token: 32 random bytes, base64url, HMAC verifier at rest;
- rights: independent `read`, `write`, `move`, `delete` booleans;
- default scopes: none; owner must explicitly select `mastermind`, `sync`, or
  the dedicated KeePass file/root;
- request body and upload limits reuse the validated file-core limits;
- If-Match is mandatory when replacing an existing file;
- DELETE is soft-delete and subject to a per-device rolling mass-delete limit;
- WebDAV XML has bounded depth (`0` or `1`) and response count;
- KeePass classification is `confidential`, share/preview/index operations are
  denied, and dedicated device rights do not imply other Drive access.

## Verification

1. Migration apply/down/apply and stable/ephemeral recovery policy.
2. One-time device token disclosure, verifier hashing, expiry and revocation.
3. Scope containment for reads, writes, MOVE/COPY destinations and encoded
   traversal attempts.
4. PROPFIND depth/XML correctness, GET/HEAD, ETag and exact Range behavior.
5. PUT create/replace, MKCOL, MOVE, COPY and soft DELETE through FileService.
6. If-Match success, missing/stale precondition and concurrent conflict-copy
   behavior with both byte streams recoverable.
7. Real rclone `ls`, `copyto`, `moveto`, `copy`, `deletefile` and checksum/readback.
8. Mastermind download/export includes Markdown, attachments and `.obsidian`.
9. KeePass opaque MIME, no preview/share, dedicated scope and current/old
   version byte recovery; opening with a real client is operator-gated if no
   master key is supplied.
10. Mass-delete limit, audit attribution and token/log/backup/artifact scans.

## Rollback

1. Disable WebDAV and revoke all device tokens.
2. Stop new sync mutations while leaving owner access available.
3. Restore affected resources or versions through the proven Stage 4 workflow;
   do not delete conflict copies automatically.
4. Roll back API/UI artifacts and migration only after stable device/audit rows
   are exported for evidence.

## Implemented result and evidence

- Migration `0008_device_sync` creates stable IDs later mapped by generation 12
  to the `mastermind`, `sync` and confidential `volt` roots, device/conflict metadata and path-driven
  retention rules.
- `@saturn/sync` owns device authentication, path containment, WebDAV
  preconditions, conflict copies and the transactional per-device delete
  window. Storage credentials remain confined to the Gateway runtime.
- Fastify serves the declared DAV methods through `DeviceService` and
  `FileService`; paged PROPFIND never bypasses the 500-item file-core query
  bound.
- Owner Settings supports recent-proof provisioning, one-time token display,
  explicit root scopes and immediate independent revocation.
- `pnpm verify:stage:9` passed 14 aggregate checks on 2026-08-26: 63 workspace
  tests/build gates, migration round trip, scope/traversal negatives, exact
  Range and ETag behavior, conflicts and versions, mass-delete protection,
  real rclone 1.75.0, complete `.obsidian` export, generated KDBX4 current/old
  recovery with a real parser, expiry/revoke, browser/Axe and secret scans.
- Machine report:
  `artifacts/verification/stage-09-device-sync-keepass.json` (SHA-256
  `627ca854a3d6610000e405a99a00b562bf32c6fcc7c8b377df6532464e3ae4bd`).
