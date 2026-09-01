DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM resources
    WHERE storage_path LIKE 'drive/%'
      AND NOT (
        storage_path = 'drive/Inbox' OR storage_path LIKE 'drive/Inbox/%'
        OR storage_path = 'drive/Laboratory' OR storage_path LIKE 'drive/Laboratory/%'
        OR storage_path = 'drive/mastermind' OR storage_path LIKE 'drive/mastermind/%'
        OR storage_path = 'drive/Passwords' OR storage_path LIKE 'drive/Passwords/%'
        OR storage_path = 'drive/Sync' OR storage_path LIKE 'drive/Sync/%'
      )
  ) THEN
    RAISE EXCEPTION 'unclassified resource data remains below legacy drive';
  END IF;
  IF EXISTS (
    SELECT 1 FROM file_versions
    WHERE storage_path LIKE 'drive/%'
      AND NOT (
        storage_path LIKE 'drive/Inbox/%'
        OR storage_path LIKE 'drive/Laboratory/%'
        OR storage_path LIKE 'drive/mastermind/%'
        OR storage_path LIKE 'drive/Passwords/%'
        OR storage_path LIKE 'drive/Sync/%'
      )
  ) THEN
    RAISE EXCEPTION 'unclassified file-version data remains below legacy drive';
  END IF;
END $$;

DROP TRIGGER IF EXISTS resources_path_policy ON resources;
DROP FUNCTION IF EXISTS vault_apply_resource_path_policy();
CREATE FUNCTION vault_apply_resource_path_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_path = 'volt' OR NEW.storage_path LIKE 'volt/%' THEN
    NEW.security_classification := 'confidential';
    IF NEW.type = 'file' AND lower(NEW.name) LIKE '%.kdbx' THEN
      NEW.retention_class := 'keepass';
    END IF;
  ELSIF NEW.storage_path LIKE 'mastermind/%' AND NEW.type = 'file' THEN
    NEW.retention_class := CASE WHEN lower(NEW.name) LIKE '%.md'
      THEN 'mastermind_markdown' ELSE 'mastermind_attachment' END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resources_path_policy
  BEFORE INSERT OR UPDATE OF storage_path, name ON resources
  FOR EACH ROW EXECUTE FUNCTION vault_apply_resource_path_policy();

UPDATE resources
SET storage_path = CASE
  WHEN storage_path = 'drive' THEN ''
  WHEN storage_path = 'drive/Inbox' THEN 'drop point'
  WHEN storage_path LIKE 'drive/Inbox/%' THEN 'drop point/' || substring(storage_path FROM char_length('drive/Inbox/') + 1)
  WHEN storage_path = 'drive/Laboratory' THEN 'laboratory'
  WHEN storage_path LIKE 'drive/Laboratory/%' THEN 'laboratory/' || substring(storage_path FROM char_length('drive/Laboratory/') + 1)
  WHEN storage_path = 'drive/mastermind' THEN 'mastermind'
  WHEN storage_path LIKE 'drive/mastermind/%' THEN 'mastermind/' || substring(storage_path FROM char_length('drive/mastermind/') + 1)
  WHEN storage_path = 'drive/Passwords' THEN 'volt'
  WHEN storage_path LIKE 'drive/Passwords/%' THEN 'volt/' || substring(storage_path FROM char_length('drive/Passwords/') + 1)
  WHEN storage_path = 'drive/Sync' THEN 'sync'
  WHEN storage_path LIKE 'drive/Sync/%' THEN 'sync/' || substring(storage_path FROM char_length('drive/Sync/') + 1)
  ELSE storage_path
END
WHERE storage_path = 'drive' OR storage_path LIKE 'drive/%';

UPDATE resources SET name = 'root' WHERE id = '00000000-0000-7000-8000-000000000001';
UPDATE resources SET name = 'drop point' WHERE id = '00000000-0000-7000-8000-000000000002';
UPDATE resources SET name = 'mastermind' WHERE id = '00000000-0000-7000-8000-000000000003';
UPDATE resources SET name = 'sync' WHERE id = '00000000-0000-7000-8000-000000000004';
UPDATE resources SET name = 'volt', security_classification = 'confidential' WHERE id = '00000000-0000-7000-8000-000000000005';

UPDATE file_versions
SET storage_path = CASE
  WHEN storage_path LIKE 'drive/Inbox/%' THEN 'drop point/' || substring(storage_path FROM char_length('drive/Inbox/') + 1)
  WHEN storage_path LIKE 'drive/Laboratory/%' THEN 'laboratory/' || substring(storage_path FROM char_length('drive/Laboratory/') + 1)
  WHEN storage_path LIKE 'drive/mastermind/%' THEN 'mastermind/' || substring(storage_path FROM char_length('drive/mastermind/') + 1)
  WHEN storage_path LIKE 'drive/Passwords/%' THEN 'volt/' || substring(storage_path FROM char_length('drive/Passwords/') + 1)
  WHEN storage_path LIKE 'drive/Sync/%' THEN 'sync/' || substring(storage_path FROM char_length('drive/Sync/') + 1)
  ELSE storage_path
END
WHERE storage_path LIKE 'drive/%';

UPDATE upload_sessions
SET target_path = CASE
  WHEN target_path LIKE 'drive/Inbox/%' THEN 'drop point/' || substring(target_path FROM char_length('drive/Inbox/') + 1)
  WHEN target_path LIKE 'drive/Laboratory/%' THEN 'laboratory/' || substring(target_path FROM char_length('drive/Laboratory/') + 1)
  WHEN target_path LIKE 'drive/mastermind/%' THEN 'mastermind/' || substring(target_path FROM char_length('drive/mastermind/') + 1)
  WHEN target_path LIKE 'drive/Passwords/%' THEN 'volt/' || substring(target_path FROM char_length('drive/Passwords/') + 1)
  WHEN target_path LIKE 'drive/Sync/%' THEN 'sync/' || substring(target_path FROM char_length('drive/Sync/') + 1)
  ELSE target_path
END
WHERE target_path LIKE 'drive/%';

DROP TRIGGER IF EXISTS laboratory_assets_validate ON laboratory_assets;
DROP FUNCTION IF EXISTS vault_validate_laboratory_asset();
CREATE FUNCTION vault_validate_laboratory_asset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_resource resources%ROWTYPE;
BEGIN
  SELECT * INTO selected_resource FROM resources WHERE id=NEW.resource_id;
  IF NOT FOUND OR selected_resource.type <> 'file' OR selected_resource.status <> 'active' THEN
    RAISE EXCEPTION 'laboratory resource is not an active file' USING ERRCODE='23514';
  END IF;
  IF selected_resource.storage_path = 'volt' OR selected_resource.storage_path LIKE 'volt/%' THEN
    RAISE EXCEPTION 'volt resources cannot be laboratory assets' USING ERRCODE='23514';
  END IF;
  IF NEW.mode LIKE 'public_%' AND selected_resource.security_classification IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'public laboratory asset requires public classification' USING ERRCODE='23514';
  END IF;
  IF NEW.pinned_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM file_versions WHERE id=NEW.pinned_version_id AND resource_id=NEW.resource_id AND state='active'
  ) THEN RAISE EXCEPTION 'laboratory pinned version is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_assets_validate BEFORE INSERT OR UPDATE OF resource_id,mode,pinned_version_id ON laboratory_assets FOR EACH ROW EXECUTE FUNCTION vault_validate_laboratory_asset();

INSERT INTO system_metadata(key, value)
VALUES ('storage_layout', '{"version":2,"root":"subaccount-home","businessRoots":["drop point","laboratory","backups","mastermind","volt","sync"],"systemRoot":"_system"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();
