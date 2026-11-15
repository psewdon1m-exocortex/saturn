-- Conservative downgrade: never silently forget initialized metadata or a binding.
DO $$ BEGIN
  LOCK TABLE resources,sync_root_clock IN ACCESS EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM resources WHERE metadata_version IS NOT NULL OR sync_availability IS NOT NULL)
    OR EXISTS(SELECT 1 FROM sync_root_clock WHERE namespace_state<>'LEGACY' OR binding_version IS NOT NULL)
  THEN RAISE EXCEPTION 'Current namespace metadata is initialized; destructive downgrade is blocked' USING ERRCODE='23514'; END IF;
END $$;
DROP TRIGGER namespace_binding_version_guard ON sync_root_clock;
DROP FUNCTION renew_namespace_binding_version();
ALTER TABLE sync_root_clock DROP CONSTRAINT sync_root_namespace_shape;
ALTER TABLE sync_root_clock DROP COLUMN namespace_state,DROP COLUMN binding_version,DROP COLUMN descriptor_schema;
DROP TRIGGER resource_metadata_version_guard ON resources;
DROP FUNCTION renew_resource_metadata_version();
ALTER TABLE resources DROP CONSTRAINT resources_sync_availability_shape;
ALTER TABLE resources DROP COLUMN metadata_version,DROP COLUMN sync_availability;
