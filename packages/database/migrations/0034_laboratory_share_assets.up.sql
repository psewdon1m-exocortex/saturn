ALTER TABLE laboratory_assets
  ADD COLUMN source_share_id uuid REFERENCES shares(id);

ALTER TABLE laboratory_assets
  ADD CONSTRAINT laboratory_assets_share_mode_check
  CHECK (source_share_id IS NULL OR mode = 'public_immutable');

CREATE UNIQUE INDEX laboratory_assets_shared_version_idx
  ON laboratory_assets(resource_id, pinned_version_id, source_share_id)
  WHERE state = 'active' AND source_share_id IS NOT NULL;

DROP TRIGGER laboratory_assets_validate ON laboratory_assets;
DROP FUNCTION vault_validate_laboratory_asset();

CREATE FUNCTION vault_validate_laboratory_asset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_resource resources%ROWTYPE;
BEGIN
  SELECT * INTO selected_resource FROM resources WHERE id=NEW.resource_id;
  IF NOT FOUND OR selected_resource.type <> 'file' OR selected_resource.status <> 'active' THEN
    RAISE EXCEPTION 'laboratory resource is not an active file' USING ERRCODE='23514';
  END IF;
  IF selected_resource.storage_path = 'volt' OR selected_resource.storage_path LIKE 'volt/%' THEN
    RAISE EXCEPTION 'password resources cannot be laboratory assets' USING ERRCODE='23514';
  END IF;
  IF NEW.mode LIKE 'public_%' AND selected_resource.security_classification IS DISTINCT FROM 'public' AND NEW.source_share_id IS NULL THEN
    RAISE EXCEPTION 'public laboratory asset requires public classification or a source share grant' USING ERRCODE='23514';
  END IF;
  IF NEW.source_share_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM shares WHERE id=NEW.source_share_id AND resource_type='folder'
  ) THEN RAISE EXCEPTION 'laboratory source share is invalid' USING ERRCODE='23514'; END IF;
  IF NEW.pinned_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM file_versions WHERE id=NEW.pinned_version_id AND resource_id=NEW.resource_id AND state='active'
  ) THEN RAISE EXCEPTION 'laboratory pinned version is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_assets_validate BEFORE INSERT OR UPDATE OF resource_id,mode,pinned_version_id,source_share_id ON laboratory_assets FOR EACH ROW EXECUTE FUNCTION vault_validate_laboratory_asset();
