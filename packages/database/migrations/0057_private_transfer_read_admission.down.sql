-- Conservative downgrade: no catalogue, accepted key, cursor or original result is deleted.
DROP FUNCTION catalog_guard_read_admission(uuid,uuid,uuid,uuid);
DROP FUNCTION catalog_upload_private_read(operation_journal);
