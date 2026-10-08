-- A downgrade must never turn a folder-scoped device into a root-scoped one.
UPDATE devices SET state = 'revoked', revoked_at = now(), updated_at = now()
WHERE device_kind = 'windows_sync' AND state = 'active';
DROP INDEX devices_sync_root_unique;
ALTER TABLE devices DROP COLUMN sync_root_id;
UPDATE backup_services SET state = 'revoked', revoked_at = now(), updated_at = now()
WHERE archive_pipeline = false AND state = 'active';
ALTER TABLE backup_services DROP CONSTRAINT backup_services_selected_pipeline_check,
  DROP COLUMN archive_pipeline;
