-- Admission counts unresolved clone reservations on every upload/stream prepare.
-- Keep that lookup proportional to pending work, not the immutable journal history.
-- This additive index does not change authority, capacity or publication predicates.
CREATE INDEX operation_pending_clone_admission ON operation_journal(sync_root_id)
 WHERE namespace_state <> 'PUBLISHED'
   AND namespace_intent->'input'->>'kind' = 'clone-content';
