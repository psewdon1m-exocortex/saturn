-- Every resource update checks for an in-flight namespace move, including the
-- ancestor size updates of ordinary uploads. Keep that guard proportional to
-- pending moves rather than rescanning the immutable operation history.
-- This additive index leaves writer authority, path membership and receipts intact.
CREATE INDEX operation_pending_namespace_guard ON operation_journal(sync_root_id)
 WHERE namespace_state = 'PHYSICAL_PENDING'
   AND namespace_intent->'input'->>'kind' IN ('move','restore','quarantine-delete');
