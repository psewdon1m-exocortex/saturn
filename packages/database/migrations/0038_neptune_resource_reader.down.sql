UPDATE devices SET state = 'revoked', revoked_at = now(), updated_at = now()
WHERE id IN (SELECT reader_device_id FROM backup_services WHERE reader_device_id IS NOT NULL)
  AND state = 'active';
DROP TRIGGER backup_services_revoke_reader_device ON backup_services;
DROP FUNCTION vault_revoke_neptune_reader_device();
ALTER TABLE backup_services DROP CONSTRAINT backup_services_reader_device_check, DROP COLUMN reader_device_id;
