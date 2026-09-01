DROP TABLE IF EXISTS operation_locks;
DROP TABLE IF EXISTS operation_journal;
DROP TABLE IF EXISTS upload_sessions;
ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_current_version_fk;
DROP TABLE IF EXISTS file_versions;
DROP TABLE IF EXISTS resources;
