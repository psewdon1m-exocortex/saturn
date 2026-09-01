DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM resources
    WHERE storage_path <> ''
      AND NOT (
        storage_path = 'drop point' OR storage_path LIKE 'drop point/%'
        OR storage_path = 'laboratory' OR storage_path LIKE 'laboratory/%'
        OR storage_path = 'mastermind' OR storage_path LIKE 'mastermind/%'
        OR storage_path = 'volt' OR storage_path LIKE 'volt/%'
        OR storage_path = 'sync' OR storage_path LIKE 'sync/%'
        OR storage_path = '_system' OR storage_path LIKE '_system/%'
      )
  ) THEN
    RAISE EXCEPTION 'unclassified resource data cannot be mapped to legacy drive';
  END IF;
END $$;

DROP TRIGGER IF EXISTS resources_path_policy ON resources;
DROP FUNCTION IF EXISTS vault_apply_resource_path_policy();
CREATE FUNCTION vault_apply_resource_path_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_path = 'drive/Passwords' OR NEW.storage_path LIKE 'drive/Passwords/%' THEN
    NEW.security_classification := 'confidential';
    IF NEW.type = 'file' AND lower(NEW.name) LIKE '%.kdbx' THEN
      NEW.retention_class := 'keepass';
    END IF;
  ELSIF NEW.storage_path LIKE 'drive/mastermind/%' AND NEW.type = 'file' THEN
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
  WHEN storage_path = '' THEN 'drive'
  WHEN storage_path = 'drop point' THEN 'drive/Inbox'
  WHEN storage_path LIKE 'drop point/%' THEN 'drive/Inbox/' || substring(storage_path FROM char_length('drop point/') + 1)
  WHEN storage_path = 'laboratory' THEN 'drive/Laboratory'
  WHEN storage_path LIKE 'laboratory/%' THEN 'drive/Laboratory/' || substring(storage_path FROM char_length('laboratory/') + 1)
  WHEN storage_path = 'mastermind' THEN 'drive/mastermind'
  WHEN storage_path LIKE 'mastermind/%' THEN 'drive/mastermind/' || substring(storage_path FROM char_length('mastermind/') + 1)
  WHEN storage_path = 'volt' THEN 'drive/Passwords'
  WHEN storage_path LIKE 'volt/%' THEN 'drive/Passwords/' || substring(storage_path FROM char_length('volt/') + 1)
  WHEN storage_path = 'sync' THEN 'drive/Sync'
  WHEN storage_path LIKE 'sync/%' THEN 'drive/Sync/' || substring(storage_path FROM char_length('sync/') + 1)
  ELSE storage_path
END
WHERE storage_path = '' OR storage_path IN ('drop point','laboratory','mastermind','volt','sync')
  OR storage_path LIKE 'drop point/%' OR storage_path LIKE 'laboratory/%'
  OR storage_path LIKE 'mastermind/%' OR storage_path LIKE 'volt/%' OR storage_path LIKE 'sync/%';

UPDATE resources SET name = 'Drive' WHERE id = '00000000-0000-7000-8000-000000000001';
UPDATE resources SET name = 'Inbox' WHERE id = '00000000-0000-7000-8000-000000000002';
UPDATE resources SET name = 'mastermind' WHERE id = '00000000-0000-7000-8000-000000000003';
UPDATE resources SET name = 'Sync' WHERE id = '00000000-0000-7000-8000-000000000004';
UPDATE resources SET name = 'Passwords', security_classification = 'confidential' WHERE id = '00000000-0000-7000-8000-000000000005';

UPDATE file_versions
SET storage_path = CASE
  WHEN storage_path LIKE 'drop point/%' THEN 'drive/Inbox/' || substring(storage_path FROM char_length('drop point/') + 1)
  WHEN storage_path LIKE 'laboratory/%' THEN 'drive/Laboratory/' || substring(storage_path FROM char_length('laboratory/') + 1)
  WHEN storage_path LIKE 'mastermind/%' THEN 'drive/mastermind/' || substring(storage_path FROM char_length('mastermind/') + 1)
  WHEN storage_path LIKE 'volt/%' THEN 'drive/Passwords/' || substring(storage_path FROM char_length('volt/') + 1)
  WHEN storage_path LIKE 'sync/%' THEN 'drive/Sync/' || substring(storage_path FROM char_length('sync/') + 1)
  ELSE storage_path
END
WHERE storage_path LIKE 'drop point/%' OR storage_path LIKE 'laboratory/%'
  OR storage_path LIKE 'mastermind/%' OR storage_path LIKE 'volt/%' OR storage_path LIKE 'sync/%';

UPDATE upload_sessions
SET target_path = CASE
  WHEN target_path LIKE 'drop point/%' THEN 'drive/Inbox/' || substring(target_path FROM char_length('drop point/') + 1)
  WHEN target_path LIKE 'laboratory/%' THEN 'drive/Laboratory/' || substring(target_path FROM char_length('laboratory/') + 1)
  WHEN target_path LIKE 'mastermind/%' THEN 'drive/mastermind/' || substring(target_path FROM char_length('mastermind/') + 1)
  WHEN target_path LIKE 'volt/%' THEN 'drive/Passwords/' || substring(target_path FROM char_length('volt/') + 1)
  WHEN target_path LIKE 'sync/%' THEN 'drive/Sync/' || substring(target_path FROM char_length('sync/') + 1)
  ELSE target_path
END
WHERE target_path LIKE 'drop point/%' OR target_path LIKE 'laboratory/%'
  OR target_path LIKE 'mastermind/%' OR target_path LIKE 'volt/%' OR target_path LIKE 'sync/%';

DROP TRIGGER IF EXISTS laboratory_assets_validate ON laboratory_assets;
DROP FUNCTION IF EXISTS vault_validate_laboratory_asset();
CREATE FUNCTION vault_validate_laboratory_asset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_resource resources%ROWTYPE;
BEGIN
  SELECT * INTO selected_resource FROM resources WHERE id=NEW.resource_id;
  IF NOT FOUND OR selected_resource.type <> 'file' OR selected_resource.status <> 'active' THEN
    RAISE EXCEPTION 'laboratory resource is not an active file' USING ERRCODE='23514';
  END IF;
  IF selected_resource.storage_path = 'drive/Passwords' OR selected_resource.storage_path LIKE 'drive/Passwords/%' THEN
    RAISE EXCEPTION 'password resources cannot be laboratory assets' USING ERRCODE='23514';
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

DELETE FROM system_metadata WHERE key='storage_layout';
