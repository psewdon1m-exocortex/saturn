DROP TABLE IF EXISTS device_enrollments;

DROP INDEX IF EXISTS devices_kind_state_seen_idx;
ALTER TABLE devices
  DROP CONSTRAINT IF EXISTS devices_client_platform_check,
  DROP CONSTRAINT IF EXISTS devices_kind_check,
  DROP COLUMN IF EXISTS last_seen_at,
  DROP COLUMN IF EXISTS client_version,
  DROP COLUMN IF EXISTS client_platform,
  DROP COLUMN IF EXISTS device_kind;

DROP INDEX IF EXISTS backup_services_pipeline_group_idx;
ALTER TABLE backup_services
  DROP CONSTRAINT IF EXISTS backup_services_pipeline_kind_check,
  DROP COLUMN IF EXISTS pipeline_group_id,
  DROP COLUMN IF EXISTS pipeline_kind;

-- Migration 0035 owns the active-deployment index. Preserve its lifecycle
-- semantics when rolling back synchronization metadata.
