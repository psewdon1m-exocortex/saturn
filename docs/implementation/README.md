# Saturn implementation program

Status: active  
Owner: system operator  
Implementation root: `C:\.projects\exocortex\saturn`  
Normative sources: `vault/docs/technical_solution_storage_gateway.md` and `C:\.projects\exocortex\.docs`

The current physical storage contract and its migration/rollback gates are
defined in `STORAGE_ROOT_LAYOUT_V2.md`. It supersedes legacy `gateway/drive`
paths in earlier stage narratives; historical migration names remain unchanged.

## 1. Program objective

Deliver a production-capable personal storage Gateway where every browser,
device, backup producer, Telegram integration and Laboratory consumer talks to
the Gateway, while only the Gateway talks to Hetzner Storage Box through a
dedicated SFTP sub-account.

Completion means that the system is implemented, deployed, observable,
recoverable and verified against the unified acceptance checklist. A feature
is not complete when it exists only in UI or configuration; its runtime limit,
negative-path behavior and recovery path must be tested.

## 2. Stage state model

Every stage uses the following state machine:

```text
NOT_STARTED
    -> READY          prerequisites and operator decisions are available
    -> IN_PROGRESS    implementation has begun
    -> VERIFYING      code is frozen except for verification fixes
    -> COMPLETE       exit criteria and evidence are satisfied

Any state -> BLOCKED  an unresolved material divergence or external blocker exists
BLOCKED -> READY      the decision or dependency is recorded and available
```

A stage may become `COMPLETE` only when:

1. every entry condition is evidenced;
2. implementation and operator documentation agree;
3. required tests pass, including the listed negative paths;
4. secrets are absent from source, logs and generated artifacts;
5. rollback or cleanup is documented and exercised where the stage mutates data;
6. material divergences have explicit recorded operator decisions.

## 3. Ordered implementation stages

### Stage 0 — Contracts, baseline and environment boundaries

**Entry state**

- technical solution and root `.docs` are available;
- the editable boundary is limited to `vault`;
- DEV Storage Box access is available or can be qualified in Stage 1.

**Work**

- create applicability, baseline, architecture, exposure and verification documents;
- select implementation stack and repository shape;
- define DEV/PROD separation and secret boundaries;
- record open operator decisions and material divergences;
- protect local secret paths from accidental source inclusion.

**Exit state**

- every normative document has an applicability status and evidence;
- all 14 stages have entry, exit and test contracts;
- architecture and environment ownership are unambiguous;
- no code implementation decision is waiting on an undisclosed divergence.

**Verification**

- documentation-link and required-section check;
- workspace write-boundary review;
- secret-path ignore review.

**Rollback**

- documentation-only changes can be reverted without runtime impact.

### Stage 1 — Storage Box qualification

**Entry state**

- Stage 0 is complete;
- DEV hostname, username, root, verified host fingerprint and protected credential are available;
- the target contains test data only.

**Work**

- verify DNS, TCP/22, host identity and authentication;
- test create, stat, list, upload, read, rename and delete;
- test streaming checksums, Range reads and writes at an offset;
- test interrupted transfer and reconnect behavior;
- measure throughput and determine safe connection-pool size;
- test a large sparse or generated stream without retaining a complete Gateway copy.

**Exit state**

- a machine-readable qualification report records capabilities and measurements;
- the SFTP library and fallback strategy are selected;
- no test objects remain remotely;
- blockers to resumable uploads are either absent or have an approved fallback.

**Verification**

- round-trip SHA-256 equality;
- remote cleanup check;
- reconnect/resume test;
- offset rewrite test;
- connection-limit and bounded-memory test.

**Rollback**

- all work occurs in a generated smoke namespace and is removed by ID.

### Stage 2 — Modular-monolith foundation

**Entry state**

- Stage 1 confirms the storage transport;
- stack and configuration contract are recorded.

**Work**

- initialize a pnpm TypeScript monorepo;
- create NestJS/Fastify API, worker and React/Vite web application;
- add PostgreSQL, migrations, configuration validation and health/readiness;
- add local SFTP and PostgreSQL integration services;
- establish unit, integration, build and secret-scan gates;
- add bounded container logging and least-privilege Compose defaults.

**Exit state**

- one command starts the development topology;
- API, database and worker health are independently visible;
- production configuration refuses placeholders and missing secrets;
- CI-equivalent local checks pass.

**Verification**

- frozen dependency install, typecheck, unit tests and production builds;
- migration apply/rollback on an empty database;
- health failure when PostgreSQL or storage dependency is unavailable;
- final artifact secret scan.

**Rollback**

- development containers and generated volumes can be removed without touching DEV Storage Box data.

### Stage 3 — StorageAdapter and file-operation core

Status: `COMPLETE` — see `STAGE_03_STORAGE_AND_FILE_CORE.md` and the accepted
machine-readable verification report.

**Entry state**

- Stage 2 runtime is healthy;
- Storage Box capability report is accepted.

**Work**

- implement provider-neutral `StorageAdapter` and SFTP adapter;
- implement resources, folders, versions and operation journal schemas;
- implement upload state machine, idempotency, locks and temporary `.part` paths;
- implement list, stat, download, create folder, move, copy and soft-delete APIs;
- implement bounded streaming and HTTP Range.

**Exit state**

- a file is visible only after verified commit;
- stable `resource_id` survives rename and move;
- retries do not create uncontrolled duplicates;
- no handler bypasses `FileService` to use SFTP directly.

**Verification**

- unit tests for paths, state transitions, Range and permissions;
- PostgreSQL + local SFTP integration suite;
- duplicate-complete and restart-during-upload tests;
- live DEV SFTP contract suite.

**Rollback**

- incomplete operations remain journaled and reconcile to a known state.

### Stage 4 — Versions, trash, reconciliation and audit

Status: `COMPLETE` — see `STAGE_04_PROTECTION_AUDIT.md` and the accepted
machine-readable verification report.

**Entry state**

- Stage 3 file operations pass integration tests.

**Work**

- implement app-level versions and category retention;
- implement trash, restore and delayed purge;
- implement reconciliation and orphan handling;
- implement structured audit, central recursive redaction and bounded logs;
- expose protected activity and diagnostic status.

**Exit state**

- overwrite and delete are reversible under policy;
- database/storage mismatches produce deterministic status and alerts;
- audit and operational logs are bounded by age, count and bytes;
- secrets never reach logs or exports.

**Verification**

- overwrite/restore and delete/restore round trips;
- missing/orphaned/hash-mismatch fixtures;
- retention boundary tests;
- known-secret corpus scan over logs and exports;
- bounded-memory log tail and export test.

**Rollback**

- purging is disabled until retention and restore verification pass.

### Stage 5 — Saturn backup and recovery

Status: `COMPLETE` — see `STAGE_05_SATURN_BACKUP_RECOVERY.md` and the accepted
machine-readable verification report.

**Entry state**

- authoritative state and audit boundaries are stable;
- Stage 4 restore operations pass.

**Work**

- implement manifested ZIP logical backups with per-member digests;
- exclude plaintext secrets, sessions, caches and reproducible artifacts;
- implement bounded spool, archive validation and transactional restore;
- create pre-restore snapshots and rollback behavior;
- document second-copy and recovery-key dependencies.

**Exit state**

- a clean compatible instance restores authoritative state;
- corrupt or hostile archives fail before mutation;
- recovery evidence records RPO/RTO measurements.

**Verification**

- clean restore, replace restore and failed-restore rollback;
- traversal, zip-bomb, unknown-member and digest-failure tests;
- plaintext-secret scan of backup bytes;
- peak RAM and spool-disk measurement.

**Rollback**

- restore always has a verified pre-restore snapshot or transaction rollback.

### Stage 6 — Authenticated owner Web UI

**Entry state**

- file and recovery contracts are stable;
- auth decisions and operator identity are configured.

**Work**

- implement login, secure sessions, CSRF and re-authentication;
- implement Files, Drop Point, Activity, Settings, versions and trash views;
- implement sticky collection command bars, keyboard behavior and responsive layout;
- implement safe previews for allow-listed formats.

**Exit state**

- the owner can perform the complete protected file workflow;
- every mutation produces pending/final feedback and an audit event;
- no credential field is application-prefilled;
- narrow and keyboard operation meet the UI contract.

**Verification**

- API authorization and CSRF tests;
- browser E2E for upload, move, overwrite, delete and restore;
- responsive and accessibility checks;
- preview MIME-forgery tests.

**Rollback**

- UI deployment can roll back independently of stored file state.

### Stage 7 — Telegram owner binding and Drop Point

Status: `COMPLETE` — see `STAGE_07_TELEGRAM_DROP.md` and the accepted
16-check aggregate report.

**Entry state**

- owner authentication and audit are production-capable;
- Telegram bot token is available through protected runtime injection.

**Work**

- implement supervised bot lifecycle and provider validation;
- implement transactional operator binding with a separate one-time link code;
- implement Drop codes, upload-only sessions, quotas and `drop point` destination;
- implement webhook secret validation or a documented polling mode;
- implement revoke and security alerts.

**Exit state**

- only the bound stable Telegram identity can request Drop access;
- a Drop session can upload but cannot list, read, overwrite or delete;
- link codes remain single-use. Drop codes are distinct, short-lived
  multi-client admission capabilities whose clients share one upload-only
  channel, absolute lifetime, quota and real-time queue.

**Verification**

- concurrent same-code channel admission and cross-channel isolation;
- forged identity/webhook, brute-force, replay and revoke tests;
- complete Drop E2E with interrupted upload;
- log and backup secret scans.

**Rollback**

- unlink and token rotation revoke access without changing owner file data.

### Stage 8 — External sharing

Status: `COMPLETE` — see `STAGE_08_EXTERNAL_SHARING.md` and the accepted
12-check aggregate report.

**Entry state**

- streaming download, audit and public-edge controls are stable.

**Work**

- implement high-entropy share tokens, expiry, password, download limits and revoke;
- implement file Range delivery, read-only folder browse and bounded packages;
- classify share routes as public non-indexable and apply no-store where required;
- prevent traversal outside the share root.

**Exit state**

- shares survive physical moves through stable resource IDs;
- revoke, expiry, trash and stricter classification stop access immediately;
- UI does not promise impossible absolute download prevention.

**Verification**

- token enumeration, password, Range and traversal tests;
- revoke during active Range requests;
- package size/count/duration limits;
- unauthorized external-vantage checks.

**Rollback**

- all shares can be globally disabled without affecting stored resources.

### Stage 9 — Device sync, Mastermind and KeePass

Status: `COMPLETE` — see `STAGE_09_DEVICE_SYNC_MASTERMIND_KEEPASS.md` and the
accepted 14-check aggregate report.

**Entry state**

- versions, audit and conflict-safe writes are proven;
- device-token scopes are designed.

**Work**

- implement WebDAV through the same `FileService` and `StorageAdapter`;
- implement scoped device tokens, ETag/If-Match and conflict copies;
- qualify real rclone and desktop clients;
- apply Mastermind indexing and retention rules;
- enforce separate KeePass scope, re-authentication and no-share/no-preview defaults.

**Exit state**

- sync cannot bypass versions, trash, permissions or audit;
- concurrent edits preserve both versions;
- Mastermind opens as an ordinary Obsidian directory after export;
- current and historical KDBX recovery is proven.

**Verification**

- WebDAV method compatibility suite;
- conflict, move-as-delete/create and mass-delete tests;
- Mastermind round trip;
- KeePass current/old-version open drill with operator-provided key.

**Rollback**

- each device token is independently revocable and sync can be disabled per path.

### Stage 10 — Backup ingest for internal services

Status: `COMPLETE` — see `STAGE_10_BACKUP_INGEST.md` and the accepted 14-check
aggregate report.

**Entry state**

- resumable uploads and Saturn recovery are stable;
- service registry schema and quotas are approved.

**Work**

- implement service identities, token hashing/rotation and optional mTLS binding;
- implement resumable backup runs, manifests, receipts, retention and dashboard;
- derive storage namespace from authenticated identity;
- support producer-side encrypted archives and restore-test evidence.

**Exit state**

- producers upload only to their own namespace through Gateway;
- producers cannot read, delete or enumerate backups;
- backup freshness and restore status are observable.

**Verification**

- cross-service privilege escalation tests;
- oversize, quota, replay and checksum mismatch tests;
- monthly-style isolated restore drill fixture;
- token rotation and revocation test.

**Rollback**

- one service identity can be disabled without affecting other producers or Drive.

### Stage 12 — Laboratory assets

Status: `COMPLETE` — see `STAGE_12_LABORATORY_ASSETS.md`.

**Entry state**

- stable IDs, sharing, Range and route classification are complete;
- public/private Laboratory policy is decided.

**Work**

- implement stable asset IDs, immutable versions and mutable aliases;
- implement public and service-token private delivery;
- emit safe Markdown fragments;
- implement ETag, Range, cache policy and optional CDN origin contract;
- apply SEO/GEO only to deliberately indexable wrapper pages.

**Exit state**

- moving a file does not break an article;
- private assets never become public through a mutable alias;
- public traffic limits and cache behavior are enforced.

**Verification**

- move/version/cache/Range tests;
- private-to-public classification tests;
- sitemap and machine-output exclusion tests for private resources;
- high-traffic bounded-stream test.

**Rollback**

- public asset delivery can be disabled while preserving owner access and bytes.

### Stage 13 — Production hardening, deployment and exit

Status: `BLOCKED` on external production inputs; local implementation is
`READY_FOR_PRODUCTION_ACTIVATION` — see
`STAGE_13_PRODUCTION_HARDENING_DEPLOYMENT.md` and `PRODUCTION_READINESS.md`.

**Entry state**

- all feature stages are complete;
- PROD sub-account, key, domain and second-copy target are provisioned.

**Work**

- build once and promote immutable artifacts;
- implement bootstrap, deployment, migrations, health gates and rollback;
- create PROD structure and run isolated smoke tests;
- execute failure injection, security, load, recovery and exit tests;
- verify unauthorized external reachability and public route policy;
- complete operational handoff.

**Exit state**

- the complete system is healthy in PROD;
- backup, restore, rollback and alternative-backend migration are exercised;
- residual risks and measured limits are documented;
- all applicable unified acceptance items pass with evidence.

**Verification**

- production smoke and functional E2E;
- database/storage/network failure injection;
- clean-host restore and update rollback;
- public/private external-vantage security checks;
- exit test to an alternative `StorageAdapter`.

**Rollback**

- previous immutable application version, configuration lock and verified logical backup remain available until new health and recovery checks pass.

### Stage 14 — Storage, Share and buffered Drop experience

Status: `COMPLETE_WITH_ISOLATED_DECISIONS` — see
`STAGE_14_STORAGE_SHARE_DROP_EXPERIENCE.md`.

**Entry state**

- the Stage 13 local release gate is green and DEV storage is reachable;
- Storage, Share, Trash and Drop already have authoritative Gateway services.

**Work**

- align Storage, Shared, Trash, public Share and public/in-house Drop with the
  new Saturn templates and the Part I interaction contract;
- add sortable collections, URL breadcrumbs, full context operations,
  responsive public states and owner folder ZIP download;
- replace direct public Drop streaming with the bounded local buffer, durable
  upload states, resumable offsets and checksum-verifying drain workers;
- expose Telegram connection and Drop buffer status in Settings.

**Exit state**

- public and in-house Drop share the same buffered pipeline;
- Share password, expiry, descendants, individual download, package download
  and revoke behavior are authoritative and smoke-tested;
- pending historical-capability and root-file policy decisions remain isolated
  and do not alter existing security or storage-root contracts.

**Verification**

- aggregate lint, typecheck, 98 tests and production builds;
- real DEV SFTP buffer/checksum/download, owner folder ZIP and public Share E2E;
- desktop/narrow public browser checks and real Access Key paste event.

**Rollback**

- stop new Drop reservations, preserve or drain staged files, and roll back the
  application/database only after the migration guard confirms no uncommitted
  buffered upload exists.

## 4. Release boundaries

| Release | Required stages | Meaning |
| --- | --- | --- |
| Storage feasibility | 0-1 | Hetzner transport assumptions are measured |
| Private alpha | 0-6 | Safe owner-only file system with tested recovery |
| Personal production | 0-10 | External access, sync and backup ingest are production-capable |
| Complete Saturn | 0-15 | Full documented scope, current Saturn UX, DR and runtime target selection are verified |

## 5. Current state

| Stage | State |
| --- | --- |
| 0 | `COMPLETE` |
| 1 | `COMPLETE` |
| 2 | `COMPLETE` |
| 3 | `COMPLETE` |
| 4 | `COMPLETE` |
| 5 | `COMPLETE` |
| 6 | `COMPLETE` |
| 7 | `COMPLETE` |
| 8 | `COMPLETE` |
| 9 | `COMPLETE` |
| 10 | `COMPLETE` |
| 11 | `COMPLETE` |
| 12 | `COMPLETE` |
| 13 | `BLOCKED` — external PROD activation inputs required |
| 14 | `COMPLETE_WITH_ISOLATED_DECISIONS` |
| 15 | `COMPLETE_LOCAL` — production target switch remains an operator deployment action |

Stage state changes are recorded in `VERIFICATION_MATRIX.md` with evidence.

### Stage 15 — Runtime storage profile

Status: `COMPLETE_LOCAL` — see `STAGE_15_RUNTIME_STORAGE_SWITCHING.md` and
`RUNTIME_STORAGE_SWITCHING.md`.

**Entry state:** one bootstrap SFTP profile, stable canonical root IDs and a
working exclusive maintenance barrier.

**Exit state:** Settings can validate and atomically select an independent SFTP
target; API/worker converge through a protected shared runtime profile; visible
catalog and storage metrics are rebuilt from that target; zero file bytes are
migrated.

**Rollback:** select the previous target again with its write-only credential.
The previous storage contents are never removed by the switch.
