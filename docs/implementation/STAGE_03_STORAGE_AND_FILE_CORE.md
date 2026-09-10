# Stage 3 — StorageAdapter and file-operation core

Status: `COMPLETE`  
Aggregate command: `pnpm verify:stage:3`  
Machine-readable evidence: `artifacts/verification/stage-03-file-core.json`  
Evidence SHA-256: `0b3bf1a2fbf81de96780aa7995bb404b1357d33e9089bc9a35b9f9164faf409e`

## Entry state

- Stage 1 accepted the real DEV Storage Box capability envelope, including a
  20 GiB transfer, restart/resume and an eight-connection pool.
- Stage 2 produced a healthy modular-monolith runtime, paired PostgreSQL
  migrations, file-based secrets and local PostgreSQL/SFTP fixtures.
- The Gateway-only data path and provider-neutral storage boundary were
  already recorded as architectural decisions.

## Implemented result

| Area | Output state |
| --- | --- |
| Storage boundary | `StorageAdapter` exposes stat, paged list, bounded reads, offset writes, truncate, mkdir, rename, copy, delete and capacity without provider types |
| SFTP implementation | Strict SHA-256 host-key pinning, file-based password/key authentication, pool limit 8, operation and stream-idle deadlines, broken-connection eviction |
| Local implementation | The same contract runs against a filesystem root with traversal and symlink rejection |
| Metadata | `resources`, `file_versions`, `upload_sessions`, `operation_journal` and expiring operation locks in paired migration `0002_file_core` |
| Upload state machine | Created → uploading → verifying → committing → active; retryable/final failure and abandoned states remain explicit |
| Commit invariant | A resource becomes visible only after exact byte count, full SHA-256 and atomic storage rename succeed |
| Mutation core | Create folder, list/stat, stable-ID move/rename, recursive copy and physical soft-delete into `_system/trash/YYYY/MM/<resource_id>` |
| Root policy | Six stable-ID preinstalled roots are rename-only; ordinary root folders support create, rename, move, copy and reversible delete; direct root files and `_system` mutations are denied |
| Concurrency | Upload and resource-tree mutations acquire database-backed expiring locks; upload offset updates use compare-and-set |
| Recovery hooks | Every multi-system mutation is journaled; failed database commits attempt a storage rollback and otherwise remain marked for reconciliation |
| HTTP API | Owner-bearer-protected endpoints for resources, folders, resumable uploads, downloads, Range, move, copy and soft-delete |
| Runtime limits | Upload maximum defaults to 20 GiB and is owner-configurable from 1–4096 GiB; it must remain at or below 90% of the configured 1–8192 GiB local upload-buffer capacity. Changes are database-backed and apply to owner and Drop uploads without restart. Incomplete TTL is 24 h, trash retention defaults to 30 d and is owner-configurable from 1–365 d for newly trashed resources, automatic purge is enabled by default, and SFTP pool 8 plus operation timeout 60 s remain validated configuration values |

## HTTP contract

| Method and route | Result |
| --- | --- |
| `GET /api/v1/resources/{id}` | Stable resource metadata |
| `GET /api/v1/folders/{id}/children` | Bounded paged child list |
| `POST /api/v1/folders` | Folder creation through `FileService` |
| `POST /api/v1/uploads` | Idempotent upload session |
| `HEAD /api/v1/uploads/{id}` | Authoritative offset, length and state |
| `PATCH /api/v1/uploads/{id}` | Streaming exact-offset append |
| `POST /api/v1/uploads/{id}/complete` | Size/SHA-256/MIME verification and atomic commit |
| `DELETE /api/v1/uploads/{id}` | Abandon incomplete upload and remove `.part` |
| `GET /api/v1/files/{id}/content` | Full or single HTTP byte range |
| `POST /api/v1/resources/{id}/move` | Stable-ID move/rename with idempotency key |
| `POST /api/v1/resources/{id}/copy` | New-ID recursive copy with idempotency key |
| `DELETE /api/v1/resources/{id}` | Journaled physical soft-delete |

Health routes remain public. File routes require a constant-time checked bearer
token loaded from a restricted file. This bootstrap owner token is deliberately
temporary; Stage 6 replaces it with the complete owner authentication and
session model.

## Verification target

The aggregate verifier must pass all of the following in one run:

1. frozen install, lint, TypeScript, unit/component tests and production build;
2. source scan proving controllers do not import `ssh2` or an SFTP adapter;
3. PostgreSQL plus local SFTP health and `0002` apply/rollback/re-apply;
4. production API/worker artifact readiness and unauthorized request denial;
5. chunk upload, persisted offset, Gateway restart, resume and checksum commit;
6. duplicate complete, full download and exact HTTP Range;
7. folder, stable-ID move, copy, physical trash and invisibility after delete;
8. incomplete upload abandonment without a visible resource;
9. live DEV `SftpStorageAdapter` contract for truncate, Range, checksum,
   copy/rename, statfs, eight parallel leases and namespace cleanup.

The live test uses a random `_vault-stage3-adapter-*` namespace and deletes
only the exact files and directory it created. It never lists, edits or removes
unrelated DEV data.

## Exit state

The accepted aggregate report contains 13 passing checks. Therefore:

- incomplete or corrupt bytes cannot appear in the active resource tree;
- retries do not produce a second committed resource;
- a move preserves `resource_id`;
- all product data access follows HTTPS/API → `FileService` →
  `StorageAdapter` → SFTP;
- incomplete cross-system operations have a journal state suitable for Stage
  4 reconciliation.

## Rollback

- A failed chunk is deleted or truncated back to its authoritative database
  offset before the session becomes retryable.
- A failed metadata commit after rename attempts the inverse rename. If that
  rollback also fails, the journal is marked `reconciliation_required` rather
  than guessing success.
- `0002_file_core.down.sql` is tested for a clean development rollback. It must
  not be used destructively after real metadata exists; production rollback is
  application-version rollback plus forward reconciliation.
- The verifier stops its API/worker processes, removes its local containers and
  local SFTP fixture, and removes its exact live DEV namespace.

## Stage 4 handoff

Stage 4 must add overwrite versions, restore, delayed purge, reconciliation
workers, append-only audit events, redaction tests and mass-change controls.
Purging remains disabled until restore and retention verification pass.
