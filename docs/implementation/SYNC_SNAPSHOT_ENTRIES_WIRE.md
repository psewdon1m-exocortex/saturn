# Snapshot entries page contract

Status: additive inactive read shape. No controller, default factory, capability,
root registration or client runtime is enabled by these readers. Existing v3
contract/fixtures/readers remain byte exact. This page extends them in new files.

An already qualified `READY` snapshot identifies one immutable final `cut_seq`
D and one snapshot ID under the complete seven-field root binding. Constructing
that snapshot, its journal overlay `(C,D]`, current authorization, durable lease,
writer coverage and unresolved-operation guards remain server requirements.

Each page carries the same binding, `snapshot_id`, `cut_seq`, nullable
`after_node_id`, nullable `last_node_id`, `items`, opaque `next_cursor` and boolean
`has_more`. At most 500 full descriptors and 4 MiB received UTF-8 bytes are allowed.
Node IDs have bounded ASCII semantics and strictly increasing ordinal order.
For the actual Saturn UUID namespace this agrees with canonical UUID key order.
The expected starting key is persisted by the consumer; it must equal the
page's `after_node_id`. `last_node_id` equals the actual final entry, or the
unchanged starting key for an empty terminal page. Empty `has_more` is rejected.
Null is the first-page starting key, never a guessed cursor. Forward response
fields remain subject to the received-byte/duplicate/scalar/depth limits.

Key ordering does not prove the server included every row. A terminal page alone
does not grant completeness. The server must retain an immutable covered snapshot
and authenticate each continuation to that same scope, cut and lease. The client
stages pages invisibly, then imports the complete committed feed after D. R,
derived dirty/replan work and its opaque cursor are committed atomically. Newer
feed changes must not be rolled back by late base snapshot entries. A interrupted
snapshot never replaces the previous active R or clears B/operations.

UNKNOWN and UNAVAILABLE descriptions remain explicit namespace entries. Neither
means absence, verified content, baseline adoption or permission to skip a local
file. BACKEND_UNCERTAIN, binding change, lease expiry or missing coverage closes
qualified use and requests reconciliation without clearing historical work.

These readers verify shape only. They never authenticate server cursor MACs,
validate a lease against the server clock, establish local source continuity,
clear a dirty generation, or implement current-version CAS.
