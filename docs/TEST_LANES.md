# Targeted test lanes and fixture custody

Use Node and pnpm versions pinned in `package.json`, from the Saturn repository root. Tests resolve workspace source through `apps/api/vitest.config.ts`, so they do not accidentally test an older sibling `dist` bundle.

## Static and portable checks

```sh
pnpm lint
pnpm typecheck
pnpm exec vitest run --config apps/api/vitest.config.ts --root . apps/api/src/guarded-sync-folder-http.test.ts packages/storage/src/sftp-pool.test.ts packages/storage/src/sftp-status-reuse.test.ts
```

Add only the files affected by the change. `pnpm test` is a broad workspace command and is not a substitute for preparing live fixtures. Some API contract scenarios write evidence even without an external backend; set `STAGE3_CHAT_A_EVIDENCE` for `stage3-chat-a.contract.test.ts`.

## Database and live integration

Guarded migrations deliberately bind functions to `public`. A per-test `search_path` schema cannot isolate them. The legacy HTTP/migration fixtures now use `isolatedTestDatabase`: a uniquely named disposable database, an absolute migrations directory and a cleanup hook. The supplied connection is used only to create/drop the owned database. It must have CREATE DATABASE rights on an isolated test PostgreSQL instance. Never supply a production database URL.

Legacy fixtures use `PLUTO_TEST_DATABASE_URL` / `PIPELINE_TEST_DATABASE_URL`. Stage 3 tests require `STAGE3_CHAT_A_FIXTURE`, a custody manifest for the disposable PostgreSQL container, and `STAGE3_CHAT_A_EVIDENCE`. The manifest checks Docker ID, creation time, ownership label and limits before use. Native SFTP tests additionally require `STAGE3_CHAT_A_SFTP`. A13 backup tests require the real `STAGE3_CHAT_A_PG_DUMP` executable; a stub dump does not qualify restore.

```sh
pnpm exec vitest run --config apps/api/vitest.config.ts --root . apps/api/src/stage3-chat-a.catalog.integration.test.ts --maxWorkers=1
pnpm exec vitest run --config apps/api/vitest.config.ts --root . apps/api/src/stage3-chat-a.lifecycle.integration.test.ts --testNamePattern '^A13' --maxWorkers=1
```

Each scenario owns a separate database and namespace. Independent files may run in parallel within measured resource reserves. Fault injection must target only a container whose custody has been checked. Do not rebuild binaries used by an active test. A15 performance/interop tests require their own data and caller artifacts; they are not implicitly covered by the A13 command.

## Native storage verifier

Run `packages/storage-verifier/src/stage3-chat-c.test.ts` on a disposable Linux filesystem, with the verifier entrypoint built at `packages/storage-verifier/dist/main.js`. The suite checks protected registry files, no-follow behavior, mutation during hashing, cancellation and SIGTERM. It is not a Windows filesystem suite. The separate A12 Linux helper also requires a current bundle and matching source hashes. Container root may be needed by ownership-changing cases; do not grant the container access to working data.

## Recovery and release evidence

Recovery admission supports both the pre-0065 PL/pgSQL validator and the post-0065 SQL wrapper plus its retained v1 helper, selected by migration ledger. Both versions retain immutable/invoker/search-path checks. The 2026-10-16 remediation repeated actual schema-47 restore, migration to 68, idempotent migration and non-activated rollback; activated guarded data requires its own recovery plan.

SFTP keepalive must not expire earlier than the configured RPC budget. A real ambiguous effect remains UNKNOWN and fenced; no timeout authorizes physical replay. Passing a bounded outage test does not authorize clearing an older uncertain namespace.

Current local receipts live in the parent workspace at `.audit/2026-10-16/pre-release-remediation/REPORT.md`. Production activation still requires [the release gate](implementation/PRODUCTION_READINESS.md), an immutable source identity and live qualification of the actual signed images/helpers.
