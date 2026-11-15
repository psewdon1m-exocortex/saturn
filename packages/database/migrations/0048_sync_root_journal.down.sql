-- Destructive rollback is deliberately blocked once publication has occurred.
-- Downgrading application binaries may leave these additive tables/columns in place.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM sync_root_changes) OR EXISTS (SELECT 1 FROM operation_journal WHERE sync_root_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM sync_root_clock WHERE published_seq > 0 OR retained_after_seq > 0) THEN
    RAISE EXCEPTION 'Cannot rollback sync root journal with published data; preserve additive schema' USING ERRCODE = '55000';
  END IF;
END $$;
DROP TRIGGER operation_sync_receipt_guard ON operation_journal;
DROP FUNCTION guard_sync_operation_receipt();
DROP TABLE sync_root_changes;
ALTER TABLE operation_journal DROP CONSTRAINT operation_sync_receipt_shape,
  DROP COLUMN sync_root_id, DROP COLUMN sync_epoch, DROP COLUMN sync_first_seq,
  DROP COLUMN sync_last_seq, DROP COLUMN sync_intent_hash, DROP COLUMN sync_result;
DROP TABLE sync_root_clock;
