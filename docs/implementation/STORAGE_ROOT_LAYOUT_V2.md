# Saturn storage root layout v2

Status: implemented; root-management policy revised in generation 13  
Decision date: 2026-09-01  
Scope: physical Storage Box paths, resource metadata, WebDAV aliases and operator bootstrap

## 1. Objective

The Storage Box sub-account starting directory is the Saturn storage root. In
production the Gateway must use `STORAGE_ROOT=.` and must not add `gateway/` or
`drive/` wrapper directories.

The canonical physical layout is:

```text
root/
├── drop point/
├── laboratory/
├── backups/
├── mastermind/
├── volt/
├── sync/
└── _system/          # hidden Gateway runtime namespace
```

The six business directories are operator-visible. `_system` is retained
because resumable uploads, file versions, trash, generated packages, previews,
metadata exports and orphan quarantine require a private runtime namespace.

## 2. Ownership and exposure

| Root | Owner | Access path | Resource reconciliation |
| --- | --- | --- | --- |
| `drop point` | Drop and Files modules | Gateway API only | scanned |
| `laboratory` | Laboratory module; visible preinstalled root | Gateway asset API and owner Files metadata | not scanned as file-resource orphans |
| `backups` | Backup Ingest module; visible preinstalled root | authenticated producer API, owner restore API and owner Files metadata | not scanned as file-resource orphans |
| `mastermind` | Files and Sync modules | owner API and scoped WebDAV | scanned |
| `volt` | Files and Sync modules | recent owner proof or dedicated scoped WebDAV | scanned; confidential policy enforced |
| `sync` | Files and Sync modules | owner API and scoped WebDAV | scanned |
| `_system` | Gateway runtime | no ordinary client access | excluded |

Storage credentials remain Gateway-only. A browser, device, backup producer or
Laboratory client never receives the sub-account credential.

## 3. Migration state machine

### Input state: `LEGACY_READY`

- Storage contains the known `drive/Inbox`, `drive/Laboratory`,
  `drive/mastermind`, `drive/Passwords` and `drive/Sync` roots, or already has
  the v2 roots.
- Legacy `drive/Archive`, `drive/Documents`, `drive/Photos` and
  `drive/Projects` are empty.
- A legacy source and its v2 target are not both non-empty.
- No unclassified file or directory exists directly below `drive`.
- Database migrations through generation 11 are applied.
- A database backup and Storage Box snapshot exist before migrating real data.

If a precondition is false, migration exits without moving data and requires an
operator merge decision.

### Transition: `MIGRATING`

1. Preflight every source/target pair.
2. Rename known physical roots without copying bytes.
3. Remove only empty legacy roots and the empty `drive` wrapper.
4. On a new or legacy installation, create missing preinstalled and `_system`
   directories. On subsequent v2 checks, preserve current stable-ID names and
   arbitrary root folders.
5. Apply database migration `0012_root_storage_layout`.
6. Restart Gateway workers and run smoke tests.

The physical migration is idempotent. It is executed before the SQL migration
by local DEV startup and runtime deployment migration scripts.

### Output state: `V2_READY`

- all six preinstalled business roots exist directly under the configured root;
- `drive` does not exist;
- root resource path is the empty relative path;
- all six preinstalled roots have stable resource IDs; their paths initially
  match the default names and may subsequently be renamed;
- WebDAV advertises `mastermind`, `sync` and `volt` only according to device
  grants;
- arbitrary ordinary folders may be created at root and support rename, copy,
  move and reversible trash;
- preinstalled roots may be renamed but not moved, copied or trashed;
- direct root files, default-role name reuse and all `_system` mutations are denied;
- `system_metadata.storage_layout.version` equals `2`;
- `system_metadata.root_folder_policy.version` equals `1` and database
  generation `0013_root_folder_policy` is active;
- no checksum or byte count changes during migration.

## 4. Verification contract

The change is complete only after:

1. unit tests prove byte-preserving, idempotent up migration;
2. unit tests prove controlled down migration;
3. collision, direct-root-file and unclassified legacy-data tests fail closed;
4. SQL migration is exercised `up -> down -> up`;
5. file, protection, Laboratory and device-sync tests pass;
6. DEV physical root is listed and contains the preinstalled directories;
7. smoke test passes `upload -> read -> download -> checksum -> delete`;
8. the complete `pnpm verify` suite passes.

## 5. Rollback

Rollback is allowed only before new writes continue in both layouts.

1. Stop API and workers.
2. Roll back `0013_root_folder_policy`, then apply
   `0012_root_storage_layout.down.sql`.
3. Run `pnpm storage:layout:down` with the same storage configuration.
4. Verify `drive/Inbox`, `drive/Laboratory`, `drive/mastermind`,
   `drive/Passwords` and `drive/Sync` and compare checksums.
5. Start the previous immutable application artifact.

`backups` and `_system` remain in place during rollback. Any source/target
collision blocks rollback and requires an explicit operator merge. Physical
rollback also requires the preinstalled roots to have their original names; a
renamed root must first be restored by stable ID.

## 6. Root-management policy

The preinstalled role is attached to these IDs, not to display names:

| Role | Stable ID | Allowed mutation |
| --- | --- | --- |
| drop point | `00000000-0000-7000-8000-000000000002` | rename only |
| mastermind | `00000000-0000-7000-8000-000000000003` | rename only |
| sync | `00000000-0000-7000-8000-000000000004` | rename only |
| volt | `00000000-0000-7000-8000-000000000005` | rename only |
| laboratory | `00000000-0000-7000-8000-000000000006` | rename only |
| backups | `00000000-0000-7000-8000-000000000007` | rename only |

Ordinary root folders have no protected ID and therefore support the complete
folder lifecycle. The browser exhausts paged root listings instead of imposing
a 500-folder ceiling. Reconciliation discovers current managed root paths from the
database, so renamed Files roots and arbitrary root folders are scanned without
depending on their names. `laboratory` and `backups` remain excluded from orphan
handling because their bytes have module-owned lifecycles.

Service-specific path resolution after a role-root rename is intentionally
deferred. Until that follow-up is implemented, modules that still use a literal
role path can fail after the corresponding root is renamed; the Gateway does not
silently recreate the old root during normal layout checks.

## 7. Environment rule

DEV and PROD are migrated independently. The release order is:

```text
DEV layout migration -> tests -> immutable release -> PROD backup/snapshot
-> PROD layout migration -> smoke test -> normal traffic
```

The DEV sub-account is never promoted into PROD.

## 8. DEV evidence

Verified on 2026-09-01:

- physical root contains the six business directories plus hidden `_system`;
- `drive` is absent;
- database generation 13, `storage_layout.version=2` and
  `root_folder_policy.version=1` are active;
- the real DEV cycle `up -> down -> up` passed for both storage and SQL;
- a second up migration produced zero actions;
- API smoke passed upload, metadata read, download, SHA-256 verification and
  reversible delete under `sync`;
- the real empty DEV Storage Box sub-account was provisioned with
  `STORAGE_ROOT=.`; a 65,573-byte remote SFTP write/read/SHA-256/delete smoke
  passed and left no smoke object;
- root-policy SQL migration passed `up -> down -> up` on local DEV;
- local HTTP smoke proved six visible preinstalled roots, ordinary root-folder
  create/move/copy/trash, preinstalled rename and rejection of move/delete,
  reserved-name reuse and direct root upload;
- aggregate lint, typecheck, 80 tests and production builds passed.
