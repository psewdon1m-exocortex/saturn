# Transfer safety, migration and recovery

Updated: 2026-10-06. Scope: migration `0046_transfer_safety` and the coordinated
Saturn, Neptune and Pluto audit fixes. Local E2E and file-transfer checks passed;
mixed-load qualification retains the open findings recorded below. Promotion
still requires the exact signed production release tuple. Central Parts 03,
04, 11 and 12 remain authoritative.

## Before upgrading

Record the deployed Saturn image digests, applied migrations, PostgreSQL and
client-tool versions, Updater/Neptune versions, active storage profile and
release trust identities. The released `saturn-v0.2.6` migration baseline has
39 migrations. Do not infer the deployed baseline from workspace package.json.
The current workspace pins Updater `0.6.10`; this pin alone is not evidence
that its signed release is available or installed.

Validate the pre-update recovery ZIP and an independent second copy. A Saturn
ZIP contains control-plane metadata, safe configuration and deployment inputs;
it does not contain the user's stored file bytes. A full disaster-recovery
point requires matching storage bytes, retained versions and the separate
encrypted secret recovery procedure. Quiesce writers while capturing a
coordinated database/storage recovery point. Do not use a database dump plus an
arbitrary later filesystem copy as evidence of a consistent point.

Check free space for the dump, bounded extraction and both original and
candidate PostgreSQL schemas. Replacement restore rejects extensions placed
in `public`; move/qualify such extensions before attempting that path.
Use a disposable copy to rehearse the exact production tuple, not the live
owner's folders. Re-run the release gates, Part 12 evidence and Stage 15 on
that candidate. Local PostgreSQL 18.1/container SFTP evidence does not qualify
another PostgreSQL version or a provider's power-loss behavior.

## Coordinated rollout

1. Stop the old Saturn API and worker before migration. Run the candidate's
   packaged forward migrations once. Existing migrations 0001–0045 are not
   rewritten; 0046 adds upload preconditions, Drop retries, share fingerprints
   and the scrub cursor. Repeating the migration is a no-op.
2. Start candidate API, worker and web from one coordinated release. Every
   filesystem mutation must hold the shared maintenance barrier; an old worker
   does not implement that contract. Avoid mixed old/new processes.
3. Check readiness, a scoped test upload/download with matching SHA-256, backup
   publication, restore into an isolated target, Drop delivery, share ZIP
   invalidation and the scrub audit. Cached share ZIPs are expired by 0046 and
   are rebuilt through the bounded worker queue.
4. Upgrade Neptune from its verified distribution and perform the Windows
   cutover below. First install Pluto through its exact signed Linux bootstrap;
   choose its dedicated production repository and protected RSA 3072+ key
   before building the first release. Do not reuse a fixture key.
5. Resume producer schedules after validating folders, identities and stored
   data. Policies loaded by a web restore remain paused until owner review.

## Concurrent transfers and worker restart

Maintenance admission uses separate pools for short query/transaction admission
and long filesystem leases before a request starts ordinary queries. Each
admission pool has eight connections; the default query pool has ten and the
independent advisory lease pool has four. Queries waiting behind
exclusive maintenance must not occupy the query pool: already admitted writers
need those connections to commit and release the barrier. PostgreSQL regression
tests cover both query and transaction traffic with only one query connection,
and short requests while all eight filesystem admission slots are occupied.
Deploy this change to API and worker together using the coordinated rollout
above; restarting a candidate alongside the former admission implementation
can retain the old starvation path. This change adds no migration.

Upload completion locks the upload and destination name during temporary-file
verification, then locks and rechecks the parent immediately before commit.
Hashing different files in one folder can proceed concurrently. A folder move
during verification uses its current path; a trashed parent rejects commit and
preserves temporary bytes. Interrupted-commit recovery still locks the parent
before touching final paths. Conditional overwrite/version guards are unchanged.

Storage remains bounded to the configured SFTP pool and waiting-queue deadlines.
Higher parallelism can increase individual transfer and backup latency even
while operator status remains responsive. Acknowledged buffered Drop uploads
remain queued when SFTP is unavailable and drain after worker recovery; exceeding
a channel's quota is an explicit rejection rather than confirmation of storage.

Transport loss signals active reads, writes and copies directly, independently
of the SSH library's remote handle-close callbacks. Idle reads fail their
consumer; write/copy deadlines reject their operation independently of pipeline
destruction. Each path retires the connection even if a dead channel never
acknowledges CLOSE. HTTP downloads and maintenance-barrier release must not
wait for that acknowledgement after a disconnected server.
Cancellation records `abandoned` plus `cleanup_pending` before attempting
temporary-file deletion. The worker drain retries that cleanup after an outage
or restart and clears the flag after deletion. This never deletes a committed
target or attempts to abandon a commit that needs reconciliation. No migration
is added; the existing operation journal retains the pending cleanup record.
The drain also retires failed empty one-shot device PUT sessions after two
minutes without an active upload lease. These are identified by their device
actor and `dav-upload-` key. User resumable sessions, partially acknowledged
bytes and active/verifying/committing uploads are excluded. This covers an
empty attempt whose immediate cancellation lost a race with its writer lease.

The mixed-load test still leaves Windows `sync-resume-*` sessions in
`failed_retryable` after the source changes and a newer upload succeeds. Their
idempotency key includes the source hash and current ETag; the client does not
cancel the former checkpoint. They remain visible as `waiting_retry` even
after the live streams finish. Do not apply the short one-shot cleanup rule to
these sessions: partial bytes may still be needed for a valid resume. A durable
client checkpoint plus scoped cancellation/supersession, expiry cleanup and
peer/append/commit race tests remain required before claiming a clean queue.

Worker startup also waits for admitted filesystem operations to release the
maintenance barrier. A live fault test observed a 49.6-second operator response
and about a minute for the controlled storage/worker/Neptune recovery sequence.
Some metadata RPCs can still consume the configured operation deadline. The
test also recorded one SFTP connect timeout during a baseline control read;
medium and maximum profiles had no flow errors. These are open availability
findings, not evidence of a corrupted acknowledged file. Detailed measurements,
test fixture boundaries and proposals are in
`../.audit/2026-10-06/saturn-mixed-load-report.md` from the Saturn repository root.

Pluto allows up to two minutes for response headers within its five-minute
request deadline so a queued Saturn commit is not abandoned after 30 seconds.
Network failures preserve the last committed file and the enabled schedule's
retry behavior. Context-menu focus is initialized on opening/changing the menu,
not on each background render, so task updates cannot change the keyboard action.

## Existing Windows connections

Migrations 0041/0042 intentionally revoke or leave unbound identities that
previously had access to the whole `sync` root. They preserve stored files.
Neither a forward migration nor downgrade grants that broad access again.

For each old Windows client, record its mappings and freeze synchronization.
Create a new Windows connection in Saturn; its Connection name becomes its
assigned folder. Redeem the new setup code in the current Neptune client. The
server supplies the folder, so the client cannot choose another client's root.
Requests to the whole `sync` root or a sibling folder must fail.

Review the old and new trees through the owner interface. If historical bytes
need moving, the owner performs that explicit move; the client must not adopt
an unknown existing tree automatically. Compare content and hashes before
enabling the first sync. An empty local scan fails before remote deletions;
mass-deletion protection remains enabled. Test rename/delete within the
assigned folder and denial at its root and at `sync` before unfreezing.

The current client verifies a strong SHA-256 receipt and resumes files of at
least 1 MiB through scoped upload sessions. A legacy server that lacks this
endpoint returns 404 and uses the old streaming PUT path; that fallback does
not provide resume. Kernel metadata fallback for an enrolled Windows client
is bounded to 24 hours, bound to the exact origin/token/key set and contains
only non-secret discovery values. A 401/403 clears this metadata cache and
stops fallback; Saturn still authenticates and supplies the folder each pass.

## Interrupted replacement restore

Replacement restore preserves the original schema in PostgreSQL and stores its
name in `_saturn_restore_guard.state`. Candidate restore, forward migration,
profile application and byte/hash verification run under the exclusive
maintenance barrier. Ordinary traffic fails closed while the guard exists.
Current and retained active versions must match; missing or different bytes
reject the restore. This operation does not rewind the storage provider.

For an interrupted operation:

1. Stop ordinary API and worker traffic. Preserve the failed workflow journal,
   database and both storage profiles. Do not manually drop the guard or the
   `_saturn_original_*` schema.
2. Inspect whether the final commit completed. Guard and original absent means
   it committed; retain the applied profile and verify it. Guard and original
   present means the original database is still recoverable. Unknown/mismatched
   state requires inspection before any automatic configuration rollback.
3. If reverting an unfinished restore, select/restore the original storage
   profile and credentials from the protected operator configuration, then
   run the candidate's CLI in the production runtime:

   ```sh
   node /app/scripts/recovery-cli.mjs rollback-interrupted
   ```

   This restores the original database schema under the exclusive barrier. It
   does not recover an earlier storage profile on its own. The command must
   run with the existing production environment, secret and runtime mounts.
4. Verify original file hashes, profile, migrations and readiness before
   restarting coordinated processes. Keep restored producer policies paused
   until verified. If rollback fails, retain the original schema and journal
   for investigation; do not resume against the candidate.

The guard is on the same PostgreSQL volume. It protects against process and
logical restore failure, not destruction of that volume. Independent verified
backups remain necessary.

## Update rollback and migration down

For a signed manifest declaring `rollback_restore: saturn-offline-v1`, current
Updater records the candidate recovery image, stops Saturn processes
and uses that image's `restore-rollback` command to restore the exact old dump
without applying candidate migrations. Only then may the old image run. The
local test exercised a 39-migration dump, forward migration to 46, exact old
schema restore, and forward reapplication. Qualify the actual Updater image
and job record as part of the production release. A historical job without
the candidate `RecoveryImage` uses the older CLI path and needs its own
recovery rehearsal; do not claim that it acquired the new behavior.

`0046` down refuses unfinished conditional uploads. Finish or explicitly
abandon them first; arbitrary column removal would discard their preconditions.
Up/down/up is tested. A reversible schema alone does not make old code's data
safety behavior equivalent: older code lacks the race, hash and ZIP fixes.

## Ongoing operation

- Drop retains valuable failed partial buffers and counts their bytes until
  physical cleanup. Transient delivery failures use exponential backoff,
  capped at one hour and ten attempts. Inspect failures and cancel unwanted
  buffers through the owner workflow; do not delete files behind the ledger.
- Interrupted completed uploads are retried by the worker. An unresolved
  physical/metadata commit blocks reads and mutation of the affected tree
  until the worker restores a consistent receipt or the operator investigates.
- Scrub checks current and retained versions in batches with a persisted
  cursor. Hash mismatch quarantines the current resource or marks the archived
  version as an error and writes an audit event. A transport failure is
  reported separately and does not falsely declare corruption. Scrub detects
  damage; recovery uses an independently verified copy.
- SFTP waiting admission and deadlines are bounded. Share ZIPs are prepared
  by the worker with global admission, not synchronously by the PostgreSQL
  production API. Worker jobs serialize across instances and drain on shutdown.
- Scheduled/manual publication removes local ZIP output on success or failure.
  Failed recovery journals are bounded; an interrupted database guard is never
  cleaned as ordinary stale scratch.
- Linux local writes and Pluto configuration sync file and parent directory;
  SFTP uses `fsync@openssh.com` where supported. Unsupported SFTP fsync is not a
  physical durability receipt. Provider parent-directory durability, native
  Windows behavior, process/network partitions beyond operation leases and
  real power-loss recovery remain separate qualification gates.
- Pluto copies ordinary files/completed database exports, preserves source
  hierarchy and empty directories, and retains up to ten versions per file.
  It continues healthy sources after a bad source, limits each file to 256 MiB
  and checks temporary snapshot space. Revoke stops access and preserves bytes.

## Local evidence

Backup retention preserves resource/version identities referenced by audit:
deleted artifacts become `purged` resources with `expired` versions. Retrying
after physical deletion but before catalog acknowledgement completes the same
purge without deleting another archive or counting ancestor sizes twice.
Catalog reconciliation and retention hold the shared maintenance barrier for
the entire storage/metadata operation, excluding replacement recovery.

Shared internal directories tolerate a concurrent creator only after verifying
the resulting directory. User folder creation remains exclusive. Public share
HEAD requests authorize and return metadata without opening content or spending
download quota.

Evidence from 2026-10-06 is in the workspace audit directory
`../.audit/2026-10-06` from the Saturn repository root. The remediation
report indexes the unit/integration, recovery fault-injection, Stage 15,
SFTP 5/20 GiB, Neptune and Pluto signing/bootstrap results. These are local
qualification records; production release/host acceptance must be fresh.

The subsequent three-service E2E report records 49 passing scenarios with real
API/worker, Neptune, Pluto, PostgreSQL and SFTP, including Saturn's actual
scheduled snapshot exporter. Its controlled discovery/export fixtures and
Linux-hosted Windows engine are identified explicitly in
`../.audit/2026-10-06/saturn-neptune-pluto-e2e.md`.

## Browser file transfers

The browser qualification uses the production web build, actual API/worker,
isolated PostgreSQL and SFTP. Its scenario matrix and evidence are recorded in
`../.audit/2026-10-06/saturn-file-ui-report.md`. Picker uploads/downloads cover
empty files through 1 GiB. Drag/drop exercises the application with disk-backed
browser FileLists; it does not qualify native desktop shell drag behavior.

Owner upload progress reflects server-acknowledged chunks rather than bytes
merely sent by the browser. Pause finishes the current chunk and blocks the
next one. Cancel interrupts the active request body, abandons the session and
prevents a late append from reviving it. Dashboard cancellation also aborts the
uploading browser, including another tab of the same origin. A cancelled
overwrite preserves the previously committed resource bytes.

After a tab reload, resume requires reselecting the original file. Its name,
size and last-modified metadata are checked before unpausing; mismatched
metadata leaves the task paused. These checks do not establish cryptographic
identity of a substituted local file with identical metadata. Completion
computes the stored file hash; initial expected SHA-256 remains optional for
browser owner uploads.

Drop exposes its server upload ID while the browser is still sending bytes,
so Remove can cancel an active upload. Its stored receipt is distinct from
the intermediate buffered receipt. Lost completion responses recover from
authoritative server status without creating a second queue entry. Buffered
delivery continues through the worker after a storage outage. Dashboard shows
Drop delivery as read-only; cancellation belongs to the Drop queue.

Dashboard global counts include the entire transfer queue, while its visible
list is bounded to 32 entries. Buffered Drop shows the completed local upload;
remote transferring progress uses the linked core session's received bytes.
Folder ZIP downloads show Streaming with transferred bytes and indeterminate
progress because the final compressed size is unknown.

Download pause holds the source behind backpressure. Server cancellation and
premature source closure fail the HTTP stream, including generated ZIPs;
closing the reply releases archive members and SFTP streams. Cancelling a
download preserves its stored source. Terminal download tasks disappear at the
next overview sample. Download control is tied to the current API process and
HTTP connection. Browser interruption tests restart the native download;
separate Range tests reconstruct and hash-check bytes. They do not establish
automatic browser resume across an API restart.

Explicit owner and public-share downloads carry a fresh operation ID in their
URL. Cancelling one retains a 60-second in-process barrier after its visible
task disappears. This rejects Chromium's automatic Range retry of the same
cancelled operation before opening storage or spending another share download.
A new explicit download receives a new ID. Legacy clients without that ID
retain request-scoped cancellation; API restart clears the in-process barrier.
Inline previews keep their existing URLs and range behavior.

The SFTP pool discards idle connections whose SSH transport or SFTP channel
has closed, and reconnects before returning another lease. Cancelled public
share streams close their underlying file handle; a premature source close
fails the response rather than leaving a hanging transfer. Share download
quota is claimed on the first content request once per authorized recipient
session, including an attempt subsequently cancelled. Retrying or starting
another explicit download in that session does not claim a second slot; a
new recipient session does.
