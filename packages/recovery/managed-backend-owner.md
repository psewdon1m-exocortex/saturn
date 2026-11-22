# Managed backend owner recovery

`ManagedBackendProcess` and `recoverExitedBackendOwner` provide an opt-in
operator boundary for a surviving process supervisor. They do not enable
heartbeat-based takeover or recovery by looking up a PID.

The supervisor must spawn the worker with a private IPC channel and a fresh
64-hex `SATURN_BACKEND_OWNER_IPC_NONCE`. Register the `ChildProcess` immediately
with the expected backend identity and generation. The worker reports its real
acquired owner/fencing token through `backendOwnerProcessReporter`. The default
worker path without this environment variable is unchanged.

Before invoking recovery, drain the other processes in the same owned cohort,
wait for the original child `close` event, and independently qualify the database
and storage dependencies. Use bounded, read-only dependency probes; do not reuse
a connection pool whose pending acquisition has not completed after an outage.
The operator database must use `maintenanceBarrier: true` and the migration
owner credentials. Runtime credentials cannot execute this operation.

Migration `0121_backend_owner_recovery_history` retains immutable proof and
receipt history. The transaction rejects a different generation/owner/token,
unqualified roots, any RUNNING or UNKNOWN physical task, claimed queued work,
or outstanding read slots. It preserves all queued task IDs and payloads.
Only a witnessed dead owner with no unresolved physical effect can release
custody. A replacement worker acquires that same generation through the ordinary
backend lifecycle. If the transaction response is ambiguous, retry the same
in-memory ticket: the immutable recovery ID makes completion idempotent.

A supervisor or host crash loses that live witness. A stored JSON proof, an
expired heartbeat or absence of a PID cannot replace it. Such cases still need
the ordinary reviewed credential fence and recovery lifecycle. No operation
here rewrites client profiles, replaces UNKNOWN originals, or manufactures
physical completion receipts.

Validation evidence for the bounded local stand is in
`.audit/2026-10-27/matrix-completion02`: owner125 (OS/SQL boundary and migration),
worker129 (worker crash), stack141 (API/worker/Kernel/PostgreSQL/SFTP crash with a
surviving supervisor), and the retained stack132 failure. These buffered-upload
checks do not claim host power-loss or in-flight physical-write recovery.

For opt-in qualified local Docker cohorts, the independent authenticated engine
fence and automatic controller are documented in
[automatic-docker-supervisor.md](automatic-docker-supervisor.md). This separate
mode does not turn a serialized managed-child receipt into a fence and does not
claim simultaneous host/engine/operator-supervisor recovery.
