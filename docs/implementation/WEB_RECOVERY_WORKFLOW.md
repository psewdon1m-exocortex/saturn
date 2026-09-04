# Web backup and recovery workflow

Status: `COMPLETE`
Verified: 2026-09-03
Surface: Settings → Backup

## Purpose and boundary

The authenticated owner can create a fresh Saturn control-plane snapshot and
download it in one click, or restore a previously created Saturn snapshot from
the web UI. The archive protects PostgreSQL metadata and safe deployment
material. It does not copy, delete or replace file bytes stored on the Storage
Box.

Only the Gateway holds database and storage credentials. The browser receives
the final ZIP download and bounded workflow metadata, never command-line or
database access.

## State contract

### Entry state

- The owner has an active Access Key session.
- `pg_dump` and `pg_restore` are available and compatible with PostgreSQL.
- The packaged deployment manifest and database migrations are readable.
- Recovery spool and retained pre-restore archive directories are writable.
- No other snapshot or restore operation owns the recovery operation lease.

The capability endpoint reports those conditions through
`GET /api/v1/operator/recovery`. UI actions are enabled only when the server
reports the relevant capability as available.

### Snapshot states

1. `IDLE`: the Backup card offers **Create snapshot**.
2. `CREATING`: the server creates a fresh custom-format PostgreSQL dump,
   portable metadata projections, redacted public configuration, deployment
   topology and migration sources in a private bounded spool.
3. `VALIDATING`: the server independently checks the completed ZIP, manifest,
   allow-list, entry sizes, expansion ratio and every SHA-256 digest.
4. `DOWNLOADING`: the same request streams the verified ZIP with attachment,
   length, backup-id and SHA-256 headers. The browser starts the download from
   the original click.
5. `COMPLETE`: the temporary server-side download copy is removed after the
   response stream closes and a redacted audit event remains.

Failure output: no partial archive is offered to the browser; spool/output
artifacts are removed and the UI reports the failure.

### Restore states

1. `SELECTED`: the native file picker supplies one `.zip` file whose declared
   size is within `maxArchiveBytes`.
2. `UPLOADING`: the browser sends exact-offset chunks no larger than
   `maxChunkBytes`; server and client report byte progress.
3. `VALIDATING`: the complete uploaded archive is extracted only into a private
   bounded directory and fully validated before any database mutation.
4. `READY`: the overlay shows filename, size, schema, creation time, member
   count and archive SHA-256. The owner must explicitly acknowledge the
   control-plane replacement and enter the final restore action.
5. `SNAPSHOTTING`: Saturn creates and validates a fresh pre-restore snapshot.
6. `APPLYING`: ordinary API and worker mutations hold shared PostgreSQL
   advisory leases; restore obtains the exclusive lease, runs `pg_restore` in
   one transaction, applies forward migrations and executes database health
   checks.
7. `COMPLETE`: verification counts and measured RPO/RTO are returned, a
   `recovery_runs` evidence row and redacted audit event are written, and the
   uploaded archive/journal are removed. Owner browser sessions are
   intentionally absent from snapshots, so the UI returns to login.

Failure output:

- invalid/hostile/incomplete archives stop before mutation;
- a restore error rolls its PostgreSQL transaction back;
- a later migration or verification error restores the already validated
  pre-restore snapshot;
- a verified pre-restore archive is retained for operator recovery;
- outcome and rollback state are recorded without exposing secret material.

## HTTP contract

| Method and route | Input | Output |
| --- | --- | --- |
| `GET /api/v1/operator/recovery` | owner session | readiness, busy state and byte limits |
| `POST /api/v1/operator/recovery/snapshots` | owner session + CSRF | verified ZIP response |
| `POST /api/v1/operator/recovery/restores` | filename + exact archive bytes | private upload id |
| `PATCH /api/v1/operator/recovery/restores/:id` | exact offset, length and bytes | next exact offset |
| `POST .../:id/validate` | complete upload | verified candidate metadata |
| `POST .../:id/apply` | exact confirmation `RESTORE` | RPO/RTO and database verification counts |
| `DELETE .../:id` | non-applying upload | removal of private upload state |

All routes require the authenticated owner. Mutation routes use the existing
same-origin CSRF contract. Restore does not request a second Access Key; the
deliberate confirmation in the overlay is the destructive-action gate.

## Dump consistency rule

Ephemeral authentication, upload, rate-limit and delivery rows are excluded
from the PostgreSQL data dump. Tables that reference excluded rows must be
excluded as the same dependency group. In particular, `operation_journal` and
`upload_sessions` are excluded together; retaining the journal without its
upload rows creates an unrestorable foreign key graph. Portable JSONL metadata
may retain the journal for forensic inspection because JSONL is not replayed as
database state.

## DEV verification evidence

The final live workflow used the real local API and PostgreSQL container:

- capability probe: export and restore enabled;
- one-click snapshot response: HTTP `201`, 95,080-byte verified ZIP;
- exact-offset upload: HTTP `204`;
- server validation state: `ready`, SHA-256
  `88f69c798e0624d78abfe0f021061e1ab79a4d6d22f82bf4b9585331effded25`;
- replacement restore: `complete`, measured RTO 1,843 ms;
- post-restore checks: 24 resources, 16 versions, 151 audit events and 23
  migrations;
- readiness after restore: `ok`;
- completed upload journal retained: `false`.

An additional isolated restore into `saturn_recovery_diagnostic` proved that
the generated `database.dump` recreates schema, data, indexes, triggers and
foreign keys before the live replacement test was allowed.

## Production dependencies

- Production images include compatible PostgreSQL client tools and packaged
  migration/deployment inputs.
- Recovery spool and retained pre-restore archives use dedicated writable
  volumes owned by the non-root application user.
- A second encrypted copy target and offline recovery key remain operator-owned
  production requirements.
- Direct external database writers would bypass the Gateway advisory barrier
  and are therefore outside the supported topology.
