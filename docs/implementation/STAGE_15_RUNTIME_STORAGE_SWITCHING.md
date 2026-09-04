# Stage 15 — Runtime storage switching

Status: `COMPLETE_LOCAL`

## Objective

Allow the owner to replace Saturn's active SFTP target from protected Settings
without copying or merging file bytes. Each target is an independent file set.

## Entry state

- Stage 14 owner UI and file workflows are operational;
- API and worker use the `StorageAdapter` boundary;
- one bootstrap SFTP profile and the stable canonical root IDs exist;
- database-wide shared/exclusive maintenance locking is available.

## Work

1. Add a write-only SFTP form behind current-session authentication, CSRF and
   recent Access Key proof.
2. Validate the pinned SSH host identity, credential, relative root and target
   permissions before any live cutover.
3. Provision `_system` and the six protected role roots, then smoke-test
   upload/read/checksum/delete on the candidate.
4. Build a bounded, fully hashed catalog from the target.
5. Under exclusive maintenance, revoke storage-bound capabilities, replace the
   active catalog, record credential-free history and publish the new runtime
   profile shared by API and worker.
6. Republish the previous profile on failure; never write to or remove content
   from the old target.

## Exit state

- Settings shows only non-secret active profile fields and reachability;
- `/files`, aggregate folder sizes, storage capacity and service writes refer to
  the selected target;
- API and worker converge on the same monotonic profile/rollback revision;
- credentials exist only in protected runtime files and cannot be read back;
- old-target bytes remain intact and zero bytes are migrated.

## Verification

- TypeScript checks pass for config, database, storage, storage health, API,
  worker and web.
- Runtime-manager tests cover cross-process convergence, secret-free metadata,
  path containment and rollback convergence.
- Settings tests cover recent-proof gating, blank credential fields, mandatory
  validation and explicit no-migration acknowledgement.
- Live `GET /api/v1/operator/storage` and `POST /test` confirm the current DEV
  SFTP profile, pinned identity, capacity and absence of response secrets.
- `verify:stage:15` passes migration `up → down → up`, then switches a
  disposable database through two temporary SFTP targets. The final target has
  one exact file and seven directories; the previous target remains intact,
  zero bytes are migrated and teardown is clean.

## Rollback

Enter the former host, port, user, root, pinned fingerprint and credential as a
new independent switch. If cutover itself fails, Saturn rolls the catalog
transaction back and republishes the previous runtime profile automatically.
