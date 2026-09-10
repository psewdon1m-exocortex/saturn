DROP TABLE IF EXISTS backup_enrollments;

DROP TRIGGER IF EXISTS backup_services_revoke_mirror_device ON backup_services;
DROP FUNCTION IF EXISTS vault_revoke_neptune_mirror_device();
DROP INDEX IF EXISTS backup_services_active_mirror_root_unique;

ALTER TABLE backup_services
  DROP CONSTRAINT IF EXISTS backup_services_namespace_deployment_unique,
  DROP CONSTRAINT IF EXISTS backup_services_mirror_device_check,
  DROP CONSTRAINT IF EXISTS backup_services_mirror_root_check,
  DROP CONSTRAINT IF EXISTS backup_services_deployment_id_check,
  DROP CONSTRAINT IF EXISTS backup_services_namespace_slug_check,
  DROP COLUMN IF EXISTS mirror_device_id,
  DROP COLUMN IF EXISTS mirror_root,
  DROP COLUMN IF EXISTS deployment_id,
  DROP COLUMN IF EXISTS namespace_slug;
