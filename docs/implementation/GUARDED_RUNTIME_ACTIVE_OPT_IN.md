# Guarded append-only sync runtime (0058)

This successor provides the ordinary API and worker composition for an explicit,
offline qualified **empty** Windows or Pluto device root. Installing the additive
migration does not enroll or activate an existing root. Existing nonempty profiles
continue through their legacy contract until a separately qualified migration.

## Supported boundary

The advertised coverage is `append-only-directories/file-cas`: durable folder-v2
ensure and file-v2 creation/overwrite with an exact target metadata condition and
ordered parent-to-root topology witness. Publication, immutable original result,
catalog/version/session and complete root events use the fixed SQL lifecycle.
Historical results do not establish the current descriptor, bytes or a new cut.

The ordinary API and worker both receive the same guarded factory. Their legacy
storage view rejects writes, truncate, mkdir, rename, copy and delete that touch a
guarded root, its control identities, source/destination ancestors or an unresolved
private owner **before backend I/O**. Registered-root legacy move/trash/restore/
purge/adoption/drop/retention effects remain unsupported and are refused; the
worker must not publish them through an alternative adapter. Old binaries and
external filesystem writers require the separate offline credential/drain fence.

Ordinary authenticated ROOT-folder creation and a second device enrollment remain
available. A new child directly under ROOT/SYNC/OUTDOOR requires a fresh private
owner proof, short SQL reservation in the existing resource and operation journal,
exact new UUID/path/name, then exclusive mkdir and fixed SQL commit. A lost mkdir
response remains unresolved; neither a later stat nor a name collision establishes
ownership. An acknowledged commit is looked up by its original identity before
any attempted compensation. Outside branches keep their legacy behavior.

## Operator prerequisites and admission

The operator must establish all of these outside request handling:

1. Fence and drain old executors; rotate/revoke the old backend credential
   generation and verify protected ancestors. A generated proof without those
   actual steps is not qualification. The local test fixture uses a fresh isolated
   backend and newly issued fixture credentials, never production credentials.
2. Install the migrations and restricted roles. The application cannot become
   the NOLOGIN fixed-function owner, alter/grant its privileges, truncate guarded
   ledgers, or invoke arbitrary definer callbacks. Only the six approved literal
   function bodies receive the narrow writer-login privilege.
3. Under maintenance, verify a fresh real device scope and an actually empty,
   AVAILABLE physical root. `catalog_guard_activate_empty` additionally validates
   empty catalog/journal/session/history, the current root/path/metadata identity,
   current device authority and a fresh protected activation proof. It preserves
   epoch/history and renews guard/binding identity. No ordinary route calls it.
4. Supply `SATURN_GUARDED_RUNTIME_MANIFEST` through protected operator files. The
   factory verifies exact function-body hashes, roles/privileges, all registered
   roots, activation hashes, backend profile revision/generation, configuration
   and actual credential-file hashes before exposing capabilities.

The strict `saturn.guarded-runtime.v1` manifest includes server/policy identity,
protected qualification/fence/cursor/writer-URL files and SHA-256 values, six
approved function identities, four distinct role identities, backend case
sensitivity and 1–16 exact root/epoch/binding/guard/activation records. Runtime
files must be regular files; symlinks and incomplete/unknown shapes fail closed.
Neither a caller label nor a custom PostgreSQL GUC is an admission permit.

The approved SQL function identities are:

- `public.catalog_folder_command(text,jsonb,jsonb)`
- `public.catalog_upload_command(text,jsonb,jsonb,jsonb)`
- `public.catalog_guard_upgrade_file(uuid)`
- `public.catalog_folder_v2_command(text,jsonb,jsonb,jsonb)`
- `public.catalog_guard_backend_uncertain(uuid,uuid)`
- `public.outside_folder_commit(uuid,jsonb)`

## Capability and resource contract

`GET /sync/v1/roots/:rootId/capabilities` revalidates the actual device, current
read/write rights, full binding, guarded read admission and backend generation.
Only an unregistered authorized root returns `404 {code:"legacy_root"}`. A
revoked/denied/uncertain/changed binding returns an error and never authorizes
legacy fallback. The response schema is `saturn.sync-capabilities.v1`, with exact
full seven-field binding, device/backend/qualification identity, the coverage
above and features `snapshot-v1`, `changes-v1`, `folder-v2`, `catalog-upload-v2`.

The base profile has four data jobs, two large jobs, decimal
`spool_bytes:"1073741824"` and a configured maximum file size at most 1 GiB.
A separately qualified v3 `scale-transfer-v2` manifest requires
`stream-upload-v1` and a payload directory, and advertises eight data jobs.
Its parser permits a decimal maximum up to `9007199254740991`; that numeric
ceiling is not a supported file-size claim or native large-file qualification.
Use the actual protected manifest, negotiated limits and matching receipts.
Modern chunks retain bounded framing and existing SQL/ancestor bounds. Exact
and folded legacy path ownership searches use indexed path lookups, including
the additive nonunique `lower(storage_path)` index; namespace/collation and name
uniqueness are unchanged.

An unfinished operation over a reduced configured size limit is refused before
backend access. An accepted historical result remains replayable at that same
identity under current authorization. Completion admits the original ID and
stream slot before even status lookup, so a same-ID retry storm cannot occupy
the command budget while the physical winner commits.

Four strictly classified private upload originals/chunks may coexist with a
current readable namespace. An unresolved public claim, `physical_pending`,
UNKNOWN, broken authority/binding or backend uncertainty still closes admission.
Changed profile/configuration/credential refuses the current process and attempts
the fixed close-only transition to BACKEND_UNCERTAIN, renewing binding while
retaining epoch/history/original outcomes. Failure to persist the close never
permits fallback. Startup without the protected manifest rejects registered roots.

Qualified aggregate-only folder size changes preserve previous AVAILABLE physical
verification only when full namespace/backend/content identity is unchanged and
the current writer is qualified. Their metadata/event versions still renew.
UNKNOWN is never promoted; topology/path/content changes do not inherit AVAILABLE.

## Migration/recovery and remaining gates

0058 is additive and leaves existing catalog/device/WAL identities intact. Its
down migration refuses an activated root or retained outside-folder original key.
Explicit safe retirement is required; automatic deletion/backfill is not a
downgrade path. Coherent logical exports retain the ACTIVE policy/dependencies;
missing/partial function, constraint or trigger shapes fail closed. Activated-root
restore remains inspection-only and requires explicit backend reconciliation;
logical metadata alone cannot prove external bytes or fencing.

Open gates include nonempty-root enrollment/migration, unsupported namespace
writers, external/old executor takeover qualification, bounded original-key
retirement, activated recovery, and native MSI install/update/autostart. Native
Windows HTTPS composition and the complete two-client six-hour stress run are
separate acceptance steps. WSL/Docker does not qualify a Windows installation.
