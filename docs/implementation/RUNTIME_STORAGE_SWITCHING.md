# Runtime storage switching

## Operator decision

The reusable security guide normally limits browser-based secret replacement
to the Access Key and Kernel token. On 2026-09-04 the operator explicitly
approved one additional, narrow workflow: replace Saturn's active SFTP
connection from Settings. This does not grant arbitrary environment, filesystem
or container access. Only the declared SFTP fields are accepted.

## Contract

Changing storage is **not migration**. Saturn does not copy bytes from the old
target and does not delete them. The selected target becomes an independent
file set. The previous Storage Box remains intact and may be selected again
later with its credential.

The active target is represented by one non-secret runtime profile plus one
write-only credential file in `STORAGE_RUNTIME_CONFIG_DIR`. The UI and read APIs
return host, port, user, root, pinned host fingerprint, authentication mode,
revision and reachability only. They never return credential contents or a
credential suffix/fingerprint.

## Entry state

- the owner has an authenticated browser session and recent Access Key proof;
- API and worker share the protected runtime-profile volume;
- the submitted host identity is pinned by an exact SHA-256 fingerprint;
- the candidate root is reachable over SFTP.

## Validation before activation

1. Strictly validate host, port, user, relative root, fingerprint and auth mode.
2. Store the submitted password or private key in a new mode-`0600` file.
3. Authenticate and verify that the selected root is a directory.
4. Reject direct files in the storage root.
5. Provision hidden `_system` directories and the six protected role roots when
   absent; preserve a per-storage hidden role-name manifest.
6. Write, read, checksum and delete a random probe below `_system/incoming`.
7. Recursively index visible folders and hash every file before live mutation.

The index is bounded to 100,000 entries and 128 levels. Exceeding either bound,
a changing file, invalid manifest, symlink, unsupported entry or failed checksum
leaves the current profile active.

Preflight is deliberately non-destructive to the old target, but it is not
read-only on the candidate: Saturn may create missing protected directories,
the hidden profile manifest and a temporary probe there. The probe is removed;
provisioned directories and the manifest remain if a later validation fails.

## Atomic switch boundary

Saturn acquires the database-wide exclusive maintenance barrier. Inside that
boundary it:

- revokes active shares, share sessions and device credentials;
- clears pending upload/Drop/package state and storage-specific backup-run
  history while retaining backup producer identities;
- disables Laboratory assets and resolves open sync conflicts;
- detaches prior resource/version metadata for immutable audit references;
- reuses the stable root and six canonical role IDs;
- installs the fully validated target catalog and initial file versions;
- records a credential-free switch row and active profile revision;
- atomically replaces the protected runtime-profile file used by API and worker.

If the transaction or profile publication fails, database changes roll back and
the prior profile is republished with a higher rollback revision so every API
and worker process converges away from the failed candidate. Worker mutations
hold the shared side of the same maintenance barrier. No old-storage bytes are
touched.

## Exit state

- `/files`, folder sizes, indexed-byte/file counts and physical-capacity metrics
  describe the selected storage;
- API and worker converge on the same profile revision;
- the active credential remains write-only;
- all new Gateway reads and writes target the selected SFTP root;
- the previous storage remains externally recoverable but is not active.

## Rollback

Open Settings → Security → Advanced security, verify the owner again and enter
the previous target's connection fields and credential. Test it, accept the
independent-file-set warning and switch. This performs another catalog rebuild;
it is not a byte restore or migration.

## Backup classification

- storage profile public fields and database switch history: conditional
  recovery metadata;
- catalog rows: authoritative for the currently selected file set;
- runtime credential and credential files: forbidden from Saturn archives;
- file bytes on either Storage Box: external authoritative data, never embedded
  in the logical control-plane snapshot.

## Verification

`pnpm verify:stage:15` prepares the local DEV dependencies and exercises the
complete A → B sequence against a disposable PostgreSQL database and two
temporary SFTP targets below the hidden DEV verification area. It verifies
provisioning, repeat profile replacement, full catalog rebuild, file
digest/read, preservation of target A, zero migrated bytes, credential-free
runtime metadata and cleanup. It never activates either target in the running
DEV API.
