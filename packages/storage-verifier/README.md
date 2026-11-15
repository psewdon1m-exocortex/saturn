# Storage verifier host (K4 r1)

Optional Linux/Node >=24 host process, separate from Pluto. This package implements the shared `packages/contracts/src/storage-verifier.ts` request and result. It is disabled until an operator installs/configures/qualifies it; no installation or execution is part of this change.

`node dist/main.js /absolute/protected/config.json` starts the host after a separately authorized build. The process reads files, hashes bytes and optionally fsyncs the exact opened file. It cannot upload, rename, delete, clone, publish, grant ownership or renew a fence. It does not claim directory durability. Other platforms are unsupported; use Saturn readback fallback.

## Protected configuration

Configuration, secret, owner and operation registry files must be regular files owned by the service UID, with no group/other permissions and exactly one hardlink. Place their directories under an operator-owned tree that untrusted writers cannot rename or modify. All paths are absolute and contain no symlink components. The content roots and registry must be separate. The shared secret has at least 32 non-whitespace characters. TLS is required except on `127.0.0.1` / `::1`; certificate and key paths use the same protected-file rules.

```json
{
  "schema": "saturn.storage-verifier-host.v1",
  "listenHost": "127.0.0.1",
  "port": 9443,
  "secretFile": "/etc/saturn-verifier/secret",
  "registryDirectory": "/var/lib/saturn-verifier/registry",
  "maximumActive": 2,
  "maximumBytes": "1073741824",
  "roots": [{
    "rootId": "00000000-0000-4000-8000-000000000001",
    "backendIdentity": "storage-primary",
    "directory": "/srv/saturn",
    "prefixes": ["files", "history", "staging"]
  }]
}
```

Prefixes are explicit normalized relative subtrees, never arbitrary request authority. Remote binding additionally supplies `tls: {certificateFile,keyFile}`. Configure only local regular-file storage; network filesystem behavior and interruption latency require separate qualification. No shell/checksum support is assumed from an SFTP server.

## Independent ownership and immutable-operation registry

The backend owner provisions entries over a separate trusted host channel. The verifier HTTP API has no registry-write endpoint. Publish registry records by private temp file → fsync → atomic rename → parent fsync. A backend handoff first drains old operations and writes a non-ACTIVE owner record; a new generation/fence requires the executor's proven stopped handoff, never a lease timeout.

`registry/owners/<sha256 UTF-8 backendIdentity>.json` contains `schema: "saturn.storage-verifier-owner.v1"`, `state: "ACTIVE"`, `backendIdentity`, `backendGeneration`, `ownerId`, `fencingToken`.

`registry/operations/<operationId>.json` contains `schema: "saturn.storage-verifier-operation.v1"`, `state: "SEALED"`, the four owner fields, and `rootId`, `operationId`, `intentSha256`, `contentVersionId`, `relativePath`, `sizeBytes`, `sha256`. Decimal sizes and lowercase SHA-256/UUIDs exactly match K4. The file must already be immutable under the backend owner's guards. Changing an operation record or current owner during verification invalidates the result. Keep the registry entry until the executor has durably resolved the operation; do not expire authority by age.

## Resource and shutdown behavior

Authenticated request/result <=64 KiB; file size must not exceed the explicit operator maximum or 9,007,199,254,740,991 bytes. `maximumBytes` can now qualify files larger than 1 GiB; the example above deliberately retains its old operator ceiling. The reader count remains 1–4, with a 64 KiB hash buffer each and <=128 path components. Requests carry a finite deadline of at most 24 hours; Saturn scales its requested deadline with the object size. All ancestors and the final file are opened with no-follow under pinned directory descriptors. Hardlinked content is rejected. Final inode/size/ctime/mtime and path identity are checked again; owner/operation registry is reread before returning VERIFIED. `file-sync` requires successful fsync; SHA equality alone is only readback.

Client disconnect/deadline cancels between reads. SIGTERM/SIGINT stop admission, cancel current work and drain sockets. A filesystem syscall already in progress completes before its next cancellation checkpoint. Errors expose only typed codes, without paths, content or credentials. Saturn must use its independent readback fallback for unsupported/unavailable results; identity/scope/hash failures remain failures.

## Integration handoff

CHAT-A owns workspace/lockfile/CI, adapters, executor and registry provisioning. Package dependencies: `@saturn/contracts` workspace and existing catalog `tsup`/`typescript`; runtime code uses Node built-ins. No new crypto/network dependencies. Imports reference the single shared source schema, matching Saturn's existing internal-package convention.

Not yet executed: build/typecheck/tests, Linux no-follow/race/cancellation qualification, real TLS, fsync/storage qualification, registry handoff and fallback integration. No PASS is claimed.

The protected operation registry also accepts `objects` (1–16 entries), each with `contentVersionId`, `relativePath`, `sizeBytes`, and `sha256`, under the common sealed owner/root/operation/intent identity. Exactly one object must match a request. This permits verification of incoming bytes and the original preimage under one operation. The original single-object record remains supported. Changing the registry while verification is active invalidates the witness; retry uses the same operation.
