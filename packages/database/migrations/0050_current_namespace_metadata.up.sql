-- Inactive namespace foundation. No root enrollment, ACTIVE transition or history backfill.
ALTER TABLE resources ADD COLUMN metadata_version uuid;
ALTER TABLE resources ADD COLUMN sync_availability text;
ALTER TABLE resources ADD CONSTRAINT resources_sync_availability_shape
  CHECK (sync_availability IS NULL OR sync_availability IN ('AVAILABLE','UNAVAILABLE','UNKNOWN'));

CREATE FUNCTION renew_resource_metadata_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.sync_availability='AVAILABLE' AND NEW.sync_availability='AVAILABLE'
    AND ROW(NEW.parent_id,NEW.name,NEW.type,NEW.size_bytes,NEW.sha256,NEW.current_version_id,NEW.status) IS DISTINCT FROM
        ROW(OLD.parent_id,OLD.name,OLD.type,OLD.size_bytes,OLD.sha256,OLD.current_version_id,OLD.status)
  THEN
    -- An unqualified legacy/direct writer cannot carry old verification forward.
    -- The prepared verified publication sets AVAILABLE explicitly after its DML.
    NEW.sync_availability:='UNKNOWN';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.metadata_version := gen_random_uuid();
  ELSIF ROW(NEW.parent_id,NEW.name,NEW.type,NEW.size_bytes,NEW.sha256,NEW.current_version_id,NEW.status,
             coalesce(NEW.sync_availability,'UNKNOWN')) IS DISTINCT FROM
        ROW(OLD.parent_id,OLD.name,OLD.type,OLD.size_bytes,OLD.sha256,OLD.current_version_id,OLD.status,
             coalesce(OLD.sync_availability,'UNKNOWN')) THEN
    NEW.metadata_version := gen_random_uuid();
  ELSIF OLD.metadata_version IS NOT NULL THEN
    NEW.metadata_version := OLD.metadata_version;
  ELSIF NEW.metadata_version IS NOT NULL THEN
    -- Explicit bounded initialization of a legacy row; never supplies historical events.
    NEW.metadata_version := gen_random_uuid();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_metadata_version_guard BEFORE INSERT OR UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION renew_resource_metadata_version();

ALTER TABLE sync_root_clock ADD COLUMN namespace_state text NOT NULL DEFAULT 'LEGACY';
ALTER TABLE sync_root_clock ADD COLUMN binding_version uuid;
ALTER TABLE sync_root_clock ADD COLUMN descriptor_schema text;
ALTER TABLE sync_root_clock ADD CONSTRAINT sync_root_namespace_shape CHECK (
  (namespace_state='LEGACY' AND binding_version IS NULL AND descriptor_schema IS NULL)
  OR (namespace_state IN ('ENROLLING','QUALIFYING','ACTIVE','BACKEND_UNCERTAIN','REBUILDING','RETIRED')
      AND binding_version IS NOT NULL AND descriptor_schema='saturn.current-namespace.v1')
);
CREATE FUNCTION renew_namespace_binding_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.namespace_state='LEGACY' THEN
    IF TG_OP='UPDATE' AND OLD.namespace_state<>'LEGACY' THEN
      RAISE EXCEPTION 'Namespace binding cannot silently return to LEGACY' USING ERRCODE='23514';
    END IF;
    NEW.binding_version:=NULL;
  ELSIF TG_OP='INSERT' THEN NEW.binding_version:=gen_random_uuid();
  ELSIF ROW(NEW.namespace_state,NEW.descriptor_schema) IS DISTINCT FROM ROW(OLD.namespace_state,OLD.descriptor_schema) THEN
    NEW.binding_version:=gen_random_uuid();
  ELSE NEW.binding_version:=OLD.binding_version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER namespace_binding_version_guard BEFORE INSERT OR UPDATE ON sync_root_clock
  FOR EACH ROW EXECUTE FUNCTION renew_namespace_binding_version();
