-- Preserve every registered original even if its upload has not begun.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_small_batches) OR EXISTS(SELECT 1 FROM sync_small_batch_operations) THEN
  RAISE EXCEPTION 'Used small batch registry cannot be removed' USING ERRCODE='55000'; END IF;
END $$;
DROP FUNCTION sync_small_batch_command(text,jsonb,jsonb,jsonb);
DROP TABLE sync_small_batches;
DROP TABLE sync_small_batch_operations;
DROP TABLE sync_small_batch_budget;
DROP FUNCTION sync_small_batch_guard();
DROP FUNCTION sync_small_batch_no_truncate();
DROP FUNCTION sync_small_batch_plan_valid(jsonb);
DROP FUNCTION sync_small_batch_binding(jsonb);
