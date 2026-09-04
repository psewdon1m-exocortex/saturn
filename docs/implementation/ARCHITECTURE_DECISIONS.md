# Architecture decisions

## Accepted decisions

| ID | Decision | Rationale | Consequence |
| --- | --- | --- | --- |
| ADR-001 | Implement a modular monolith | One owner and one deployment benefit from a small operational surface | Modules communicate through service interfaces; handlers cannot access SFTP directly |
| ADR-002 | Use TypeScript, NestJS with Fastify, and Node streams | The technical solution explicitly permits TypeScript/NestJS; Fastify and streams support bounded data transfer | Streaming and memory budgets require explicit integration tests |
| ADR-003 | Use React + Vite for the web UI | Matches the technical solution and supports the required operational interface | UI remains a client of protected Gateway APIs |
| ADR-004 | Use PostgreSQL for metadata and queues | Resources, audit, sessions and jobs need transactions and relational constraints | Database backup and restore become mandatory before external features |
| ADR-005 | Treat Storage Box as a dumb SFTP backend | External clients must not receive storage credentials | Every operation passes through `StorageAdapter` and `FileService` |
| ADR-006 | Use one PROD Gateway sub-account and application-level service isolation | Hetzner sub-accounts cannot see sibling directories; backup producers must not connect directly | Service identity determines namespace, quota and permissions server-side |
| ADR-007 | Keep DEV and PROD separate from creation | DEV is never promoted into PROD | Separate sub-account, SSH key, DB, secrets and configuration are required |
| ADR-008 | Use the sub-account home as the storage root, protect six preinstalled roots by stable ID and permit arbitrary user folders beside them | Stable IDs preserve rename-only protection without reserving the entire root; `_system` remains hidden and immutable | PROD uses `STORAGE_ROOT=.`; direct root files and reuse of default role names are denied; migration generation 13 is required |
| ADR-009 | Assign stable sortable IDs independent of path | Moves and backend migration must not break shares or Laboratory links | UUIDv7-compatible IDs are stored in PostgreSQL |
| ADR-010 | Model cross-system mutations as state machines plus an operation journal | Storage Box and PostgreSQL do not share a transaction | Reconciliation is part of correctness, not optional maintenance |
| ADR-011 | Do not use D1/R2 or external Sites hosting | Saturn must run as the documented self-hosted Gateway and Storage Box data path | Sites guidance is limited to web-product structure and validation |
| ADR-012 | Promote the same immutable artifact from tests to PROD | Rebuilding after testing does not prove byte identity | Production deployment consumes a verified digest |
| ADR-013 | Scope sync clients to stable logical root IDs and preserve KeePass as an opaque confidential file | Paths can move physically without changing authority; Gateway must not handle a KeePass master key | WebDAV resolves only `mastermind`, `sync` and `volt`; KDBX preview/share/index are denied and conflict copies retain both inputs |
| ADR-014 | Derive backup namespaces exclusively from HMAC-authenticated service identity | A compromised producer must not choose another service's path or receive Storage Box credentials | Producer routes are upload/status-only; quota, receipt, retention and restore evidence remain owner-controlled |
| ADR-015 | Treat an operator-selected SFTP target as an independent active file set, never an implicit migration | Switching providers must not copy or merge unknown bytes and the UI/catalog must describe the selected target | Preflight and full hashing precede an exclusive catalog rebuild; active shares/devices/transfers are revoked; the previous storage remains untouched |

## Environment topology

```text
DEV Gateway -> DEV key -> Storage Box sub1 -> test data only
PROD Gateway -> PROD key -> Storage Box sub2 -> real Saturn data
Main account -> offline break-glass -> both sub-account namespaces
```

Using one physical Storage Box is accepted initially but is not complete
failure isolation: capacity, snapshots and external-reachability policy are
shared. Before PROD, either both Gateways must operate inside the trusted
Hetzner network with external reachability disabled, or PROD must move to a
separate Storage Box.

## Open operator decisions

| Decision | Default until decided | Latest required stage |
| --- | --- | --- |
| Canonical PROD domain | No production exposure | 6 |
| One shared or separate DEV/PROD Storage Boxes | Shared only before real PROD data; separate is preferred | 13 |
| Public Laboratory traffic | Private | 12 |
| mTLS for producers | Scoped token first; mTLS required when source identity warrants it | 10 |
| Independent second-copy target | Required but unset | 5 |
| Metadata RPO/RTO | 6 hours / 4 hours baseline | 5 |
| Antivirus | Disabled until an isolated scanner is qualified | 6 |

## Material divergences and containment

| ID | Difference | Impact | Current decision / containment |
| --- | --- | --- | --- |
| MD-001 | A working DEV password is stored as plaintext under `docs` with broad inherited ACL | Local disclosure and accidental packaging risk | Added source exclusion; credential must move to restricted runtime secret storage before Stage 2 completion |
| MD-002 | User topology initially places DEV and PROD sub-accounts on one physical Storage Box | Shared capacity and reachability reduce isolation | Allowed only with explicit exposure controls; separate PROD box remains recommended before real data |
| MD-003 | The selected v2 business layout names only six root directories and omits runtime internals | Omitting runtime internals would break upload commit, versions, trash and reconciliation contracts | Six business roots are direct children of the sub-account home; hidden `_system` is retained and excluded from ordinary UI |
| MD-004 | Part VII permits only Access Key and Kernel token browser secret rotation, while the operator requested SFTP credential replacement in Settings | Adds a high-impact secret and external-provider control surface | Explicitly approved by the operator on 2026-09-04; constrained to strict SFTP fields, CSRF + recent proof, pinned identity, write-only credential, protected volume, pre-activation validation, audit and rollback |
