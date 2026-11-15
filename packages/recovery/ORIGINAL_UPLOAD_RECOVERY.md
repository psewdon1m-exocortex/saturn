# Offline recovery of an original catalog upload

These operator APIs repair a narrowly proved original v2 CREATE upload. They are
not a general `UNKNOWN` reset, a lease-expiry takeover, or a way to publish a new
upload with replacement IDs. Runtime and catalog writer roles cannot apply them.

Before using them, stop API clients, native clients, readers and the backend
owner. Keep the authenticated supervisors alive: the `OfflineBackendFence`
must verify their current, exact child-process close witnesses, together with
the reviewed owner, fencing token and generation. A parsed receipt, an absent
PID, a stale heartbeat or an expired lease alone is insufficient.

Preserve the original operation, upload, node, version, claim, intent, device,
root binding and pending-set preimages. Read the entire physical file and check
its size and SHA-256 against the immutable original. Check the counterpart path
is genuinely absent. Reject competing work, a revoked device, mismatched IDs,
an ambiguous result, an overwritten target or any unsupported command.

The supported transitions are:

1. `reconcileCompletedCatalogEffects` proves the complete reviewed set of
   outstanding write/rename effects for the drained owner. It persists their
   actual results and counters once, retains the recovery history and stops the
   owner. It does not replay physical I/O, publish the catalog or reset a root.
2. `recoverOriginalCatalogUpload` (migration 0123) publishes the same original
   upload only when its completed write and rename receipts, full target bytes,
   absent temp and original provenance satisfy the recovery plan.
3. `resumeUnstartedCatalogUpload` (migration 0125) handles the distinct case
   where the full private temp exists and **no rename task was ever accepted**.
   It restores `physical_pending` with the original claim. Obtain that sealed
   claim through `CatalogUploadDatabaseCoordinator.prepare`, perform the first
   real rename through the normal durable backend executor, then call the
   coordinator's normal commit. Resumption itself is not publication.

Recovery plans bind the exact SQL preimage, fresh physical evidence and live
fence evidence. Apply each plan atomically through the privileged operator
connection. Keep both failed and successful evidence; retry only according to
the API's idempotency rules and the current preimage. Do not edit journal fields,
clear uncertainty or construct a new claim by hand.

Qualify the whole procedure on a separate database **and a separate physical
storage root**. A database clone still points at the original file paths. Passing
the original SFTP adapter to a clone can move the original file while changing
only the clone's catalog. Use independent regular-file copies for qualification;
verify afterward that the original paths, bytes and database remain unchanged.

Migration 0124 only adds the partial lookup index for catalog job reservations;
it changes neither admission limits nor timeouts. Migrations 0123/0125 preserve
durable operator recovery history. Their down migrations deliberately refuse to
discard applied plans: retain the audit trail and qualify a forward repair rather
than deleting history to make a downgrade succeed. No automatic production
rollout or downgrade is implied by these APIs.
