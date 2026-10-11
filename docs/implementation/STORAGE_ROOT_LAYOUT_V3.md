# Saturn storage root layout v3

Status: implemented in database generation 47

Layout v3 gives every Saturn-managed root an immutable, visibly reserved name:

```text
# drop point/
# laboratory/
# mastermind/
# volt/
# references/
# sync inner services/
# sync windows/
# sync outdoor connections/
_system/
```

The root objects cannot be renamed, copied, moved or trashed. Their contents
retain the policy of the owning subsystem. Ordinary owner-created root folders
remain fully manageable.

## Stable identities and protocol compatibility

- The v2 `backups` UUID is retained by `# sync inner services`.
- The v2 `sync` UUID is retained by `# sync windows`.
- Drop Point, Laboratory, Mastermind and Volt retain their UUIDs.
- `# references` and `# sync outdoor connections` receive new fixed UUIDs.
- Existing Pluto connection-folder UUIDs are reparented directly below
  `# sync outdoor connections`; the former `pluto` container is retired.
- WebDAV aliases `/dav/sync`, `/dav/mastermind` and `/dav/volt`, backup
  producer routes and Pluto API routes do not change.

Consequently device token hashes, producer token hashes, scopes, setup state
and client configuration are not rotated by the migration.

## Upgrade

The runtime migration first preflights every destination, performs SFTP
rename operations without copying file bytes, then applies database migration
`0047_storage_layout_v3`. Pluto is transformed from
`backups/pluto/<connection>` to
`# sync outdoor connections/<connection>`.

Database generation 47 rewrites physical resource, version, resumable-upload
and backup final paths while preserving resource IDs. Backup receipts retain
their public `/backups/<service>/...` namespace so deployed producers remain
compatible. The migration records
`system_metadata.storage_layout.version = 3` and root policy version 2.

If the database migration fails, the runtime migration returns physical paths
to v2 before exiting. Update rollback uses the candidate recovery CLI to run
the same v3-to-v2 physical migration before restoring the pre-update database.

## Fail-closed conditions

Migration stops before changing data when:

- an old and target directory both contain data;
- the v2 Pluto subtree contains a direct file instead of connection folders;
- a target root name is already owned by another resource;
- canonical v2 resource paths do not match the production layout.

Rollback preserves outdoor connection data by returning it to
`backups/pluto/<connection>`. It refuses rollback while `# references`
contains data because v2 has no equivalent root.

## Verification

Release verification must cover:

1. v2-to-v3 and v3-to-v2 byte preservation;
2. idempotent repeated migration;
3. direct Pluto connection placement;
4. unchanged Windows and Pluto device IDs, token hashes and scope IDs;
5. unchanged backup producer identities;
6. URL encoding of `#` as `%23` in owner navigation;
7. update failure and automatic rollback across both database and storage.
