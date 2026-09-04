# Stage 14 — Storage, Sharing And Drop Experience

## Objective

Bring the owner Storage, Shared, Trash and Settings views and the public Share
and Drop flows to the Saturn UI/UX contract while preserving the Gateway as the
only storage authority. Add a bounded local Drop buffer and make every visible
transfer state correspond to authoritative backend state.

## Source Of Truth

- `C:/.projects/exocortex/.docs/PART_I_INTERFACE_AND_INTERACTION_UNIFICATION.md`
- the applicable security, observability, backup, update and Telegram rules in
  `C:/.projects/exocortex/.docs/`
- the Saturn templates in `C:/.projects/exocortex/saturn/.src/`
- the operator requirements recorded in the task that introduced this stage

The root specification is read-only. This document records how it is applied
inside Saturn.

## Stage 14.1 — Contract And Compatibility Baseline

### Entry state

- owner authentication, file CRUD, reversible trash, public shares and the
  existing direct-to-storage Drop upload path pass their current tests;
- resource IDs and protected-root rules are already authoritative;
- the DEV Storage Box is reachable through the Gateway.

### Work

- record material differences before changing them;
- define UI states, API shapes, database migrations and rollback boundaries;
- preserve all existing storage bytes and stable resource IDs.

### Exit state

- every remaining material difference is either explicitly decided or isolated
  so independent work cannot prejudice the decision;
- this stage document and the architecture decision log agree.

### Verification gate

- documentation review;
- clean type check and existing test baseline.

## Stage 14.2 — Owner Storage Workspace

### Entry state

- folder navigation resolves stable resource IDs from URL path segments;
- file and folder operations work through authenticated Gateway APIs.

### Work

- sortable `Name`, `Modified` and `Size` headings with visible direction;
- clickable breadcrumbs and refresh-safe canonical folder URLs;
- folder outline, accent selection and accent underline;
- pointer and keyboard context menu with Copy, Cut, Paste, Download,
  New folder, Delete, Rename and Share;
- browser-session clipboard for copy/cut and an explicit paste operation;
- viewport-wide operating-system file drop target;
- cached/indexed folder size only; unknown size renders as an em dash;
- share creation and share-status details from the selected resource.

### Exit state

- all menu actions call the same Gateway service operations as the visible
  toolbar;
- protected roots cannot be moved or deleted from any UI path;
- no recursive SFTP size walk is triggered by listing a folder.

### Verification gate

- component/type tests for sorting, menu enablement and path generation;
- API integration tests for copy, cut/move, trash, rename and share;
- browser test for refresh, Back/Forward, context menu, keyboard and OS drop.

## Stage 14.3 — Owner Shared, Public Share And Trash

### Entry state

- active share records contain policy and counters but store capability tokens
  only as non-reversible hashes;
- public folder browsing and bounded ZIP generation already exist;
- trash is reversible.

### Work

- searchable active owner share list with two rankings, expandable policy details,
  copy action for a currently available capability and immediate revoke from
  an authenticated owner session without an additional recent-proof prompt;
- share creation asks access, optional expiry and optional password;
- public password gate appears only for locked shares;
- public open view exposes expiry, availability, per-item size, total size,
  individual file download and bounded download-all;
- expired/revoked/exhausted capabilities render a neutral not-found state;
- Trash uses the same collection hierarchy, sorting and selection mechanics.

### Exit state

- public folder descendants cannot escape the shared root;
- every content response still claims a download session exactly once;
- revoke invalidates the public capability immediately;
- a successfully revoked object disappears from the Shared collection immediately;
- revoke remains protected by the owner session and CSRF validation;
- old capability URLs are never reconstructed from hashes.

### Verification gate

- share service/controller tests for locked, open, expired, descendant and
  download-limit cases;
- browser tests for password gate, folder traversal, individual download,
  download-all, share expansion and revoke;
- trash restore regression tests.

### Owner Trash interface contract

- because no dedicated Trash bitmap exists, the screen derives its geometry
  from Storage and its record interaction from Shared: a single lowercase
  `trash` title, a live collection summary, a right-aligned search field,
  sortable headings and individually outlined records;
- search covers the visible/original name, storage path and resource type;
  `Name`, `Deleted` and `Size` retain the shared sort interaction and direction
  indicator, while Retention always shows the authoritative purge deadline or
  `Manual`;
- opening a record reveals type, deletion time, purge deadline, original name,
  original parent ID and current state. Opening details never starts a restore;
- Restore is an explicit row action followed by a confirmation dialog. Success
  removes the item immediately and then reconciles the list with Gateway;
- trashed files expose a separate `Delete permanently` action; it is never
  available for folders and always opens an irreversible-action warning. The
  active owner session plus CSRF protection authorize it without a second
  Access Key prompt; Gateway physically deletes the stored bytes, expires every
  file version, preserves only the purged metadata tombstone/audit record, and
  removes the file from the live Trash list after confirmation;
- the route has no unrelated Quick upload action. Narrow layouts keep the
  complete record table horizontally scrollable and stack detail facts without
  discarding fields.

## Stage 14.4 — Buffered Public And In-House Drop

### Entry state

- a Drop code creates an upload-only channel and each client receives its own
  scoped session credentials;
- the existing implementation streams upload chunks directly to SFTP;
- no local durable queue survives a page refresh.

### Work

- code admission and channel/session lifetime share one absolute timestamp 30
  minutes after issue; aggregate reservation limit: 100 GiB;
- local Drop buffer budget: 110 GiB with configured warning, refusal and
  emergency watermarks based on both buffer usage and host free space;
- resumable chunk reception into non-public local staging files;
- authoritative states:
  `UPLOADING -> BUFFERED -> TRANSFERRING -> VERIFYING -> STORED`, with
  `FAILED` and `CANCELLED` terminal branches;
- two background drain workers by default and a hard configuration maximum of
  four;
- checksum verification before `STORED` and atomic Gateway commit into the
  Drop Point root;
- channel-shared list/status/remove/cancel endpoints, server-sent upload
  snapshots and browser restoration;
- expiry blocks new reservations while already-started uploads retain a
  bounded continuation lease;
- in-house Drop combines a Storage pane constrained to Drop Point with an
  always-authorized upload pane that uses the same buffer pipeline.

### Public gate template contract

- the closed `/drop` state follows `saturn drop point closed.png`: a centered
  `255 x 170px` code gate, `17px` vertical gap and `255 x 50px` textual service
  reachability row;
- the code control opens empty, uses `Code...`, submits through the active
  `Enter` action and never places the secret code in URL or browser storage;
- the opened state follows `saturn drop point opened.png`: a `684px` centered
  composition, an `80px` Space Grotesk service title and a `684 x 584px`
  level-one panel;
- the opened panel contains the upload-only notice, a live `MM:SS` Drop-code
  status, independent service reachability and a full-width dashed upload
  surface. The empty state is template-exact; real session jobs and non-normal
  buffer/error states expand inside or below that surface without exposing a
  storage listing;
- viewport-wide OS file drop and the upload-surface file chooser invoke the
  same buffered upload path. Session expiry and buffer refusal disable new
  files while preserving already-started task state;
- the same unexpired code may be redeemed concurrently on multiple devices.
  They share the channel expiry, quotas and authoritative upload queue; changed
  upload snapshots are delivered through SSE without exposing storage listing;
- distinct Drop channels in same-origin browser tabs are pinned with a
  non-secret History-state channel identifier, so a cookie updated by another
  tab cannot silently switch the current tab after refresh or reconnect;
- an OS-file drag activates the same full-viewport upload overlay used by the
  authenticated Storage workspace. Real upload jobs render as inset bordered
  rows inside the dashed surface; `STORED` status and its progress fill use the
  semantic success green, while incomplete states retain the accent color.

### In-house template contract

- authenticated `/inbox` follows `saturn in house drop point.png` as one
  two-panel workspace below a single `drop point` page header;
- the left panel is the normal Storage collection rooted at the stable Drop
  Point resource. URL path traversal, sorting, selection, context actions and
  nested-folder navigation remain available, while navigation above Drop Point
  is impossible;
- the shared command row places the confined breadcrumb and live item summary
  over the collection and the Storage search control over the upload panel.
  The duplicate Storage heading, `Upload here` action and global Quick upload
  are omitted on this route;
- the right panel is permanently authorized by the owner session and displays
  `Drop code status: none`. It reuses the public upload-only notice,
  reachability status, dashed target, buffered upload path and real job states;
- reaching `STORED` in the right-hand queue invalidates the left collection
  snapshot, so the committed resource becomes visible without a page reload;
- wide screens retain the reference side-by-side composition. Narrow screens
  preserve the same reading order as breadcrumb, search, collection and upload
  panel without removing any file-manager capability.

### Exit state

- no public Drop request receives Storage Box credentials or lists storage;
- API restart and page refresh recover durable upload status;
- `BUFFERED` never means stored remotely, and `STORED` is emitted only after
  checksum verification;
- buffer exhaustion fails closed before consuming unsafe disk space.

### Verification gate

- unit tests for quota reservation, offsets, watermarks, cancellation and
  state transitions;
- integration tests for restart recovery and worker claiming;
- smoke test `upload -> buffer -> transfer -> checksum -> visible resource`;
- browser tests for closed/open templates, refresh, timer expiry, cross-tab
  channel isolation and real-time peer upload snapshots.

## Stage 14.5 — Settings Completion

### Entry state

- Appearance, Security, Backup, Updates and Logs cards exist;
- Kernel URL/token and basic Telegram/device controls exist.

### Work

- align all mandatory groups with the unification specification;
- expose Telegram configuration/binding state without returning secrets;
- add Drop buffer policy and worker status, Storage connection diagnostics,
  sharing defaults, session controls and bounded retention summaries where
  responsibilities already exist in Saturn;
- keep unavailable backup/update actions explicitly unavailable with a reason.

### Exit state

- controls represent authoritative service state after reload;
- secret inputs are write-only and always reopen empty;
- destructive mutations require recent owner proof and confirmation.

### Verification gate

- Settings API and permission tests;
- keyboard/narrow-screen/accessibility browser pass;
- secret-redaction inspection.

## Stage 14.6 — Release Gate

### Entry state

- stages 14.1–14.5 pass their local gates.

### Exit state

- database migrations apply forward on a copy of DEV state;
- package tests, lint, type check and production build pass;
- local API, worker and web processes pass health and browser smoke tests;
- a real DEV Storage Box smoke test passes without touching production data;
- rollback instructions cover application version, migrations and buffered
  files without silently deleting uncommitted uploads.

## Material-Divergence Register

### MD-14-01 — Drop pipeline and limits — operator decided

- Previous behavior: direct SFTP-backed upload, 15-minute session, 20 files and
  20 GiB, date-namespaced destination.
- New requirement: local buffer, one 30-minute issue-anchored Drop lifetime,
  100 GiB, direct Drop Point root destination and background workers.
- Impact: persistence, disk capacity, upload semantics and operations.
- Decision: adopt the new staged design. The task introducing Stage 14 is the
  explicit operator authorization.
- Rollback: stop new reservations, drain or preserve staged files, then return
  the API to the previous version; never delete uncommitted staging files as an
  implicit rollback step.

### MD-14-02 — Re-copying historical capability URLs — pending

- Applicable rule: capability tokens must not be derivable from the stored
  share record and must not be logged or exposed broadly.
- Previous behavior: only an HMAC is persisted and the URL is disclosed once.
- Requested UI: every existing share row has a Copy link action.
- Options: keep one-time disclosure and show Copy only while the token remains
  in page memory; rotate/reissue a capability for historical rows; or add an
  encrypted recoverable-token store with a separate key and migration.
- Recommendation: reissue/rotate explicitly. It preserves non-recoverable
  storage and makes invalidation visible.
- Blocked work: historical-row Copy behavior only. Search, ranking, expansion,
  creation and revoke continue independently.

### MD-14-03 — Files directly in storage root — pending

- Previous behavior: arbitrary root folders are allowed, but files cannot be
  stored directly in root.
- Template difference: the Storage root visibly offers `Upload here`.
- Options: preserve the folder-only root; permit root files and update the
  storage layout contract; or show upload only below root.
- Recommendation: preserve the folder-only root until the operator explicitly
  changes the root contract.
- Blocked work: root-level file upload only. Viewport drop works in every
  eligible folder.

### MD-14-04 — Public Drop gate composition — operator decided

- Previous behavior: one `820px` panel combined a branded header, generic
  health badge, code form, policy row, upload surface, empty queue and explicit
  session-end action.
- Requested behavior: use the supplied Saturn closed/opened Drop Point
  templates and the shared interface-unification tokens.
- Decision: adopt the templates. The operator request is the explicit choice
  required by the material-divergence protocol.
- Compatibility path: API, secret-code admission, buffered upload, refresh recovery,
  cancellation, expiry and refusal semantics remain unchanged. Runtime-only
  queue, buffer and error content appears only when it carries real state, so
  the normal empty opened state retains the reference composition.

### MD-14-05 — Shared multi-client Drop channel — operator decided

- Previous behavior: redemption consumed the Drop challenge, so a second
  device could not join. Upload mappings and quotas belonged to one client
  session, while same-origin tabs could silently adopt whichever Drop cookie
  was written last.
- Requested behavior: one still-valid Drop code admits multiple devices into
  one shared upload queue with real-time task visibility.
- Decision: introduce an explicit channel between challenge and client
  sessions. Each device gets independent HttpOnly/CSRF credentials; the
  channel owns the absolute expiry, quota and uploads. SSE distributes changed
  upload snapshots, and a non-secret per-tab History-state channel ID rejects
  accidental cross-channel cookie replacement.
- Bounds: code admission and the shared channel close at one absolute timestamp,
  30 minutes after code issue. Joining late never extends that lifetime,
  exposes storage listing, or adds read/download rights.

## Test Evidence

### 2026-09-02 — automated release gate

- `corepack pnpm verify` passed: ESLint, all workspace type checks, 98 tests
  and every production build completed successfully;
- migration `0020_buffered_drop` applied to the DEV database; its manifest and
  guarded rollback are covered by the database test suite;
- focused File Core, Drop, Share, API, Worker and Web suites passed after the
  folder-download and buffered-pipeline changes.

### 2026-09-02 — real DEV Gateway and SFTP smoke tests

- in-house session opened without a visible code;
- a test file progressed `buffered -> stored`, appeared directly in Drop Point,
  and matched its SHA-256 through both owner and public downloads;
- a no-expiry share returned no `expiresAt`, and revoke changed public metadata
  to HTTP 404 immediately;
- owner folder download produced a valid ZIP containing the expected nested
  path and exact file bytes;
- a password-protected folder share passed locked metadata, unlock, two-level
  browsing, descendant download, bounded `Download all`, expiry metadata and
  revoke-to-404;
- smoke resources were revoked where applicable and moved to reversible Trash.

### 2026-09-02 — browser checks

- the login Access Key is a normal text input; an actual `Ctrl+V` paste event
  populated it and the test value was then cleared;
- the closed public Drop page reached `Available`, matched the centered template
  hierarchy and had no horizontal overflow at a 390 x 844 viewport;
- a syntactically valid unavailable capability rendered the neutral Saturn
  Share 404 state;
- browser console inspection returned no warnings or errors for the checked
  public states.

### 2026-09-03 — in-house Drop Point UI gate

- the focused web type check and all 21 web tests passed;
- the in-house contract test verifies the stable Drop Point root constraint,
  dual-panel headings, root boundary breadcrumb, Storage search, always-open
  upload target, `none` code state, service reachability and the absence of
  duplicate upload actions.

### 2026-09-03 — owner Trash UI gate

- the focused web type check and all 22 web tests passed after the Trash
  redesign;
- the Trash contract test covers live summary values, search, expandable
  authoritative metadata, explicit confirmation, Gateway restore and immediate
  removal of the restored record.

### 2026-09-03 — shared Drop channel gate

- `corepack pnpm verify` passed: ESLint, all workspace type checks, 114 tests
  and every production build completed successfully;
- migration `0022_drop_shared_channels` was applied to DEV and passed an
  isolated PostgreSQL `up -> down -> up` round trip with all three channel
  foreign-key columns restored;
- a real local Gateway smoke used two independent cookie jars and user agents:
  both redeemed the same code into one channel with different client session
  credentials and identical expiry, the second saw and cancelled the first
  client's temporary upload, and a mismatched channel hint returned HTTP 401;
- a live SSE connection on the second client received the first client's new
  upload snapshot without refresh; the temporary buffer entry was cancelled;
- after restarting DEV with the new configuration, the real code response and
  two independent client sessions returned one identical expiry approximately
  30 minutes after issue; the second redemption did not extend it;
- the local `/drop` gate rendered successfully with healthy database, storage
  and worker checks and no browser console errors.

A UI screenshot is evidence only when paired with functional API/state
verification. MD-14-02 and MD-14-03 remain intentionally isolated pending the
operator decisions recorded above; neither affects the completed smoke paths.
