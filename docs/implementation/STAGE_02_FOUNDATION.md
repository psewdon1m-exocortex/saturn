# Stage 2 — Modular-monolith foundation

Status: `COMPLETE`  
Aggregate command: `pnpm verify:stage:2`  
Machine-readable evidence: `artifacts/verification/stage-02-foundation.json`  
Evidence SHA-256: `72c9fd6b350a33fd24f9cdad4d10986cdc1d02a98db5ece181eeab6be98dddf8`

## Entry-state evidence

- Stage 1 is `COMPLETE` with an accepted 20 GiB SFTP qualification report.
- The selected stack is TypeScript 5.9 on Node.js 24, pnpm 11, NestJS
  11/Fastify 5, React 19/Vite 8 and PostgreSQL 18.
- Storage transport limits and the provider-neutral boundary are recorded.

## Implemented foundation

| Area | Result |
| --- | --- |
| Workspace | Eight-project pnpm workspace with exact versions and frozen lockfile |
| Supply chain | Lifecycle scripts denied by default; only required `esbuild` is allowed; optional SSH native builds are explicitly disabled |
| API | NestJS/Fastify artifact with independent liveness and dependency-aware readiness |
| Worker | Separate Fastify process, PostgreSQL heartbeat and independent health endpoints |
| Web | React/Vite private shell, `noindex,nofollow,noarchive`, health proxy and responsive/reduced-motion baseline |
| Configuration | Zod validation, safe relative storage root, file-based secret references and fail-closed production rules |
| Database | PostgreSQL pool, heartbeat repository and paired transactional up/down migration |
| Storage readiness | Key-authenticated, SHA-256 fingerprint-pinned SFTP realpath probe |
| Local topology | Digest-pinned PostgreSQL and SFTP Compose services bound to loopback only |
| Local secrets | Random generated values and keys under ignored paths with non-inherited Windows ACLs |
| Operations | `pnpm dev:up` prepares infra, applies migrations and starts API/worker/web in one command |
| Resource bounds | Container pids, memory, CPU and JSON log size/count limits |

## Verification evidence

The accepted aggregate run completed from
`2026-08-25T23:23:03.754Z` to `2026-08-25T23:23:52.997Z` and passed all
13 checks:

1. frozen dependency installation and supply-chain policy verification;
2. strict lint;
3. TypeScript checking for all seven product projects;
4. 11 unit/component tests;
5. production builds for packages, API, worker and web;
6. Compose validation;
7. PostgreSQL and local SFTP container health;
8. migration apply, rollback and re-apply;
9. API/worker production-artifact readiness with DB, storage and heartbeat;
10. SFTP stop → readiness 503 while liveness 200 → recovery 200;
11. PostgreSQL stop → readiness 503 while liveness 200 → recovery 200;
12. private web artifact policy;
13. scan of 100 source/artifact files against four exact secret values.

The manual one-command smoke additionally verified the Vite UI on port 5173,
its API proxy and clean release of ports 3000, 3001 and 5173 on shutdown.
The aggregate verifier removed all DEV containers; ports 2222, 3000, 3001,
5173 and 55432 were confirmed free afterward.

## Security corrections made during verification

The initial local SFTP fixture exposed two development-only weaknesses: a
Windows-mounted host key appeared as mode `0777`, and password-form user data
was echoed by the fixture image. That container and its log were deleted, the
generated password was removed, and the topology was changed to:

- a host key copied inside the container and forced to mode `0600`;
- a separate keypair for client authentication;
- a passwordless `users.conf` record with no credential to log;
- strict verification of the generated ED25519 host fingerprint.

The accepted verification run uses only this corrected topology.

## Exit state and handoff

- `pnpm verify:stage:2` is repeatable, fail-closed and writes bounded JSON
  evidence.
- Configuration rejects production password auth, non-HTTPS origin,
  placeholders, missing key references and unsafe storage roots.
- Database and storage failures are classified separately without affecting
  liveness.
- Stage 3 may add provider-neutral storage operations; API handlers must not
  import `ssh2` or address the Storage Box directly.

## Rollback

`pnpm dev:down` removes the DEV containers. PostgreSQL uses tmpfs at this stage,
and all generated local SFTP data stays under `vault/data/sftp`; no rollback
operation touches the qualified remote DEV Storage Box.
