# Automatic local Docker cohort supervision

This opt-in operator tool adds an independent recovery boundary for the real
API/worker cohort. It is not installed, enabled or reachable from an HTTP route
by the ordinary application. Build the workspace, then invoke
pnpm recovery:supervise /absolute/private/config.json SHA256.

The configuration schema is saturn.automatic-docker-cohort-supervisor.v1.
The trusted operator provides an authenticated local Docker endpoint (Unix
socket or Windows named pipe), the exact engine ID and Docker executable SHA,
two existing healthy API/worker container IDs/Created/image digests, ownership
label, backend identity/generation, and writable cohort volume names. The
password file, configuration, private environment copies and fsynced journal
must be outside every runtime bind mount and readable only by the operator.
The database connection is an explicitly published loopback operator port;
runtime credentials cannot use the recovery-history schema. No secret is passed
on the supervisor command line or written to a public log.

The worker must run through scripts/registered-worker-parent.mjs, which launches
the real worker through the existing private owner IPC reporter. A fresh protected
nonce, the actual live parent/worker PID births and executable/argv digests, and
the exact registered owner/generation/fence must match the database. The engine
client verifies that live association inside the exact worker container and
checks the parent script SHA before accepting custody. An unregistered or wrong
worker is refused. Container StartedAt is pinned as well as Created, so a manual
restart cannot silently substitute a new process incarnation.

The supervisor first captures the exact live cohort and its actual RUNNING
owner/fencing token. Failure means an actual stopped registered container, not
an expired heartbeat. It drains the remaining old peers, records actual daemon
wait/exit results, and permanently removes the old container IDs without
removing any volume. If a peer cannot drain in 30 seconds, an explicit recorded
KILL is the independent fencing action. Every immutable identity and the local
engine are rechecked; another active writer on the declared volumes refuses.
The live engine-backed capability cannot be manufactured from a JSON receipt.

Only after that physical process fence does an exclusive-maintenance SQL
transaction validate the same generation/owner/token, qualified ACTIVE roots,
no RUNNING/UNKNOWN physical tasks, no claimed queued work and no read slots.
Queued originals and payloads are unchanged. Uncertain physical effects are
retained and stop automatic recovery; no successful effect is invented. The
existing manual managed-child recovery API retains the same guards and status.
The engine proof and release result are retained in immutable recovery history.

A replacement worker then starts through the ordinary runtime, acquires a new
owner/fencing token in the same generation, and becomes ready before the API is
started. Application images, credentials, storage/data volumes, transport
ceilings and original IDs are preserved. Only declared ephemeral output bind
mounts may receive a fresh generation directory. The bounded recovery budget
is explicit. The private stop-file nonce, or SIGTERM on a supporting host,
requests normal API-before-worker shutdown, actual worker exit0 and API exit0
or Nest SIGTERM143, and observed database-pool closure. Refusal or incomplete
database closure exits nonzero within a bounded cleanup deadline; normal stop
never silently escalates to KILL.

The scope is real owner/API/worker unit failure with the authenticated Docker
engine, operator supervisor, PostgreSQL and SFTP service surviving. A simultaneous
host/engine/operator-supervisor failure, unresolved physical UNKNOWNs, foreign
writers, host PID/network mode or arbitrary remote Docker endpoint is outside
this automatic mode. This is not a heartbeat lease or a global Docker repair.
Qualified release fault evidence must use actual product processes and storage;
unit/mock checks alone are not takeover acceptance.
