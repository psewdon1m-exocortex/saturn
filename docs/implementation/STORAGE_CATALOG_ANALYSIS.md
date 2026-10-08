# Storage analysis and catalog synchronization

On 2026-10-05 the operator requested a forced comparison of the connected
storage with Saturn's catalog, followed by a report and explicit synchronization.
This workflow concerns the current SFTP profile and keeps existing resource IDs.

## Operator workflow

1. Open Settings → Storage connection → Storage catalog → Analyze storage.
2. The worker lists visible folders and streams SHA-256 for every file, including
   files whose size did not change. Analysis never writes, moves or deletes bytes.
3. Review new, changed, absent and blocked entries in the saved report. The task
   continues after leaving Settings; returning loads the latest report for the
   active profile and revision. Reports show 100 findings per page.
4. If there are applicable differences and no blocked entries, select
   “Apply the reported changes to the catalog” and click Synchronize catalog.
5. The worker repeats the complete comparison. If either the catalog, storage
   inventory or profile changed, the report becomes stale and must be regenerated.

Owner session and CSRF protection apply. No additional Access Key entry is
required. Selecting a different target remains the separate
[runtime storage switching](RUNTIME_STORAGE_SWITCHING.md) workflow.

## Application boundary

After verification, an exclusive maintenance transaction serializes catalog
updates with normal Gateway operations and target switching. Synchronization:

- imports new folders/files with initial version metadata;
- preserves IDs of existing resources and updates size, digest and MIME metadata;
- marks absent resources and their live versions as missing;
- recomputes folder totals and revokes shared links to affected resources and
  their ancestor folders;
- inherits confidential Volt and Mastermind retention policies by stable role ID;
- commits the completed job together with all catalog changes.

Device identities and storage credentials are retained. File bytes are preserved.
An external overwrite cannot supply Saturn with the old bytes: the previous live
version's metadata is retained as missing history, while an independently archived
version remains intact. A renamed external file is represented as an absent old
path and an imported new path; identity cannot be inferred from names alone.

Protected roots that disappeared, immutable content changes, direct root files,
pending/trash/type collisions, case conflicts and invalid paths block application.
Symlinks and unsupported adapter entries fail the scan. Resolve the finding and
analyze again; partial results are never applied.

The hidden `_system` tree and detached metadata are excluded. Background
reconciliation records unknown visible files as `awaiting_owner_catalog_analysis`
and leaves them in place. Files moved by older versions into `_system/orphaned`
remain hidden; recovering them requires deliberately returning them to a visible
folder before a new analysis.

## Durable jobs and bounds

Migration `0043_storage_catalog_analysis` adds `storage_catalog_jobs`. API and
worker must be updated together after applying migrations. The worker polls every
two seconds; a two-minute lease renewed every 15 seconds allows another worker to
restart an abandoned scan. Only one analysis or synchronization runs at a time.

Each scan is bounded to 100,000 entries, 128 levels, 32 MiB of inventory metadata,
64 MiB of report metadata and one hour. File hashing uses streams. The latest ten
reports are retained; they contain paths and comparison metadata, never credentials
or file content. Structured audit events record requests, results and failures.

Reports and leases are reproducible operational state and are excluded from logical
recovery snapshots. Resource/version rows remain authoritative catalog data.

## Failure and rollback

A failed application rolls back the entire catalog transaction. An expired report
does not modify resources. A failed connection can be retried with a new analysis.
The down migration refuses active jobs; finish them before rolling back the schema.
Rolling back code or the job table cannot recover externally overwritten bytes.

Verification uses an isolated temporary PostgreSQL database and local storage,
covering read-only analysis, same-size changes, import, missing files, preserved
IDs, stale reports, transaction rollback, lease recovery and paired migrations.
