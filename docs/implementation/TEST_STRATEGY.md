# Test strategy

## Test layers

1. **Unit:** path normalization, state machines, token hashing, scopes, Range,
   retention rules.
2. **Component:** module behavior with controlled adapters and failure fixtures.
3. **Integration:** PostgreSQL plus local SFTP; transactions, retries and
   reconciliation.
4. **Live contract:** opt-in tests against DEV Storage Box in a generated
   namespace; never against PROD.
5. **API security:** authentication, authorization, CSRF, replay, traversal,
   size limits and error uniformity.
6. **Browser E2E:** protected owner workflows, Drop, Share, accessibility and
   responsive behavior.
7. **Recovery:** logical backup round trip, failed restore, clean-host recovery
   and RPO/RTO measurement.
8. **Failure injection:** SFTP disconnect, PostgreSQL failure, restart during
   upload, disk/spool full, duplicate requests and mass delete.
9. **Deployment:** immutable artifact, migration, health gate, rollback and
   unauthorized external-vantage checks.
10. **Exit:** export files and metadata, import into an alternative adapter and
    compare hashes and stable links.

## Safety rules

- Live tests require an explicit DEV environment marker and refuse PROD-like
  host/user/root values.
- Every live test uses a generated prefix and records every remote object it
  creates for cleanup.
- Tests never print credentials, authorization headers or complete provider
  responses.
- Test artifacts use explicit allow-lists and are scanned before retention.
- Large-file tests stream deterministic bytes and measure peak memory; they do
  not create multiple full in-memory copies.
- Destructive tests run only after backup/restore is proven and only inside a
  generated test namespace.

## Stage gate command contract

Each stage will expose one aggregate command:

```text
pnpm verify:stage:<number>
```

The command must fail closed and write a bounded machine-readable report under
`artifacts/verification/`. Those artifacts are local evidence and are excluded
from source control unless a sanitized summary is deliberately committed.
