DROP TABLE IF EXISTS reconciliation_issues;
DROP TABLE IF EXISTS reconciliation_runs;
DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
DROP FUNCTION IF EXISTS vault_deny_audit_mutation;
DROP TABLE IF EXISTS audit_events;
ALTER TABLE upload_sessions DROP COLUMN IF EXISTS overwrite_resource_id;
DROP INDEX IF EXISTS file_versions_purge_idx;
DROP INDEX IF EXISTS file_versions_resource_created_idx;
ALTER TABLE file_versions
  DROP COLUMN IF EXISTS purge_after,
  DROP COLUMN IF EXISTS archived_at,
  DROP COLUMN IF EXISTS state;
ALTER TABLE resources DROP COLUMN IF EXISTS retention_class;
ALTER TABLE resources DROP CONSTRAINT resources_status_check;
ALTER TABLE resources ADD CONSTRAINT resources_status_check
  CHECK (status IN ('pending', 'active', 'trashed', 'missing', 'error', 'quarantined'));
