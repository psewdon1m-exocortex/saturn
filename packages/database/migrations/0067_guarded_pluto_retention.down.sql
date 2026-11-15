-- Do not erase durable deletion originals or turn expired bytes back into live
-- history. A deployed retention writer requires a reviewed forward migration.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_retention_originals) THEN RAISE EXCEPTION 'retention_originals_require_forward_migration'; END IF;
END $$;
DROP TRIGGER sync_retention_pin_guard ON laboratory_assets;
DROP TRIGGER sync_retention_schedule ON file_versions;
DROP TRIGGER sync_retention_schedule_root ON catalog_guard_roots;
DROP FUNCTION sync_retention_command(uuid,jsonb),sync_retention_schedule(),sync_retention_schedule_root(),sync_retention_pin_guard();
DROP TABLE sync_retention_originals,sync_retention_work;
DROP INDEX file_versions_active_retention,sync_small_batch_retention_pin;
DROP FUNCTION sync_retention_original_guard(),sync_retention_no_truncate();
