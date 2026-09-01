# Existing baseline

Recorded: 2026-08-25  
Scope: `C:\.projects\exocortex\saturn`

## Repository state

- No application source, package manifest, database schema, migrations, tests,
  deployment files or CI workflows existed at baseline.
- The directory contained the technical solution and a local plaintext DEV
  Storage Box password file.
- No Git worktree was detected at the `vault` path during baseline inspection.
- Node.js 24 and npm are installed. Docker CLI and Docker Compose are installed.
- Go and `psql` are not installed on the host PATH.

## Verified external behavior

The DEV Storage Box endpoint was tested on 2026-08-25:

| Capability | Result |
| --- | --- |
| DNS A and AAAA | Pass |
| TCP port 22 | Pass |
| Supplied RSA host fingerprint | Pass |
| Password authentication from protected local file | Pass |
| Remote root for `STORAGE_ROOT=.` | `/` inside the DEV sub-account |
| Create directory | Pass |
| Upload and download | Pass |
| Round-trip SHA-256 | Pass |
| Rename, delete and remove directory | Pass |
| Remote cleanup verification | Pass |

Large-file resume, offset writes, throughput, memory bounds and connection-pool
limits remain unverified and belong to Stage 1.

## Current security boundaries

- DEV uses `u657278-sub1`; no production sub-account is configured.
- The DEV password file is excluded by the new root `.gitignore`.
- The current Windows ACL on the password file is too broad: ordinary users
  can read it and authenticated users inherit modification rights.
- The credential must be moved to a restricted secret path and rotated before
  production. It must never enter an image, source archive, log or backup.
- No public Gateway listener currently exists.

## Known gaps

- No independent second copy.
- No PostgreSQL or metadata schema.
- No auth, audit, recovery, deployment or operator UI.
- No measured SFTP reconnect/resume behavior.
- No DEV/PROD network-exposure proof.
- No implementation verification evidence beyond the basic SFTP smoke test.
