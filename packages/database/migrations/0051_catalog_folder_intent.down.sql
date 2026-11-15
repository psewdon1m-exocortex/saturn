LOCK TABLE operation_journal IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM operation_journal WHERE catalog_intent IS NOT NULL) THEN
   RAISE EXCEPTION 'Accepted catalog folder keys require explicit retirement before downgrade; catalogue and metadata are preserved' USING ERRCODE='55000';
 END IF;
END $$;
DROP INDEX operation_catalog_folder_pending_idx;
DROP TRIGGER operation_catalog_folder_truncate_guard ON operation_journal;
DROP FUNCTION guard_catalog_folder_truncate();
DROP TRIGGER operation_catalog_folder_guard ON operation_journal;
DROP FUNCTION guard_catalog_folder_intent();
ALTER TABLE operation_journal DROP CONSTRAINT operation_sync_receipt_shape,DROP CONSTRAINT operation_catalog_folder_shape;
DROP FUNCTION catalog_folder_shape(operation_journal);
ALTER TABLE operation_journal DROP COLUMN catalog_intent,DROP COLUMN catalog_effect_state;
ALTER TABLE operation_journal ADD CONSTRAINT operation_sync_receipt_shape CHECK (
 (sync_root_id IS NULL AND sync_epoch IS NULL AND sync_first_seq IS NULL AND sync_last_seq IS NULL AND sync_intent_hash IS NULL AND sync_result IS NULL)
 OR (sync_root_id IS NOT NULL AND sync_epoch IS NOT NULL AND sync_intent_hash IS NOT NULL AND sync_intent_hash ~ '^[a-f0-9]{64}$'
   AND ((sync_first_seq IS NULL AND sync_last_seq IS NULL AND sync_result IS NULL)
     OR (sync_first_seq IS NOT NULL AND sync_last_seq IS NOT NULL AND sync_first_seq>0 AND sync_last_seq>=sync_first_seq AND sync_result IS NOT NULL AND state='active')))
);
