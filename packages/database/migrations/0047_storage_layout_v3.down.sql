DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM resources
    WHERE parent_id='00000000-0000-7000-8000-000000000008' AND status='active'
  ) THEN RAISE EXCEPTION '# references must be empty before storage layout rollback'; END IF;
  IF EXISTS (
    SELECT 1 FROM resources
    WHERE storage_path LIKE '# sync outdoor connections/%'
  ) AND NOT EXISTS (
    SELECT 1 FROM resources
    WHERE storage_path LIKE '_system/orphaned/layout-v3-pluto-%' AND name='pluto' AND status='purged'
  ) THEN RAISE EXCEPTION 'Pluto v2 container identity is unavailable for rollback'; END IF;
END $$;

CREATE TEMP TABLE saturn_layout_v3_pluto ON COMMIT DROP AS
SELECT id
FROM resources
WHERE storage_path LIKE '_system/orphaned/layout-v3-pluto-%' AND name='pluto' AND status='purged'
ORDER BY created_at LIMIT 1;

UPDATE resources
SET storage_path='backups/pluto/' || substring(storage_path FROM char_length('# sync outdoor connections/') + 1),
    parent_id=CASE WHEN parent_id='00000000-0000-7000-8000-000000000009'
      THEN (SELECT id FROM saturn_layout_v3_pluto LIMIT 1) ELSE parent_id END,
    updated_at=now()
WHERE storage_path LIKE '# sync outdoor connections/%';

UPDATE file_versions
SET storage_path='backups/pluto/' || substring(storage_path FROM char_length('# sync outdoor connections/') + 1)
WHERE storage_path LIKE '# sync outdoor connections/%';

UPDATE upload_sessions
SET target_path='backups/pluto/' || substring(target_path FROM char_length('# sync outdoor connections/') + 1),
    updated_at=now()
WHERE target_path LIKE '# sync outdoor connections/%';

UPDATE resources
SET parent_id='00000000-0000-7000-8000-000000000007',storage_path='backups/pluto',
    size_bytes=(SELECT size_bytes FROM resources WHERE id='00000000-0000-7000-8000-000000000009'),
    status='active',updated_at=now()
WHERE id IN (SELECT id FROM saturn_layout_v3_pluto);

UPDATE resources
SET size_bytes=size_bytes+(SELECT size_bytes FROM resources WHERE id='00000000-0000-7000-8000-000000000009')
WHERE id='00000000-0000-7000-8000-000000000007';

UPDATE resources
SET storage_path = CASE
  WHEN storage_path='# drop point' THEN 'drop point'
  WHEN storage_path LIKE '# drop point/%' THEN 'drop point/' || substring(storage_path FROM char_length('# drop point/') + 1)
  WHEN storage_path='# laboratory' THEN 'laboratory'
  WHEN storage_path LIKE '# laboratory/%' THEN 'laboratory/' || substring(storage_path FROM char_length('# laboratory/') + 1)
  WHEN storage_path='# sync inner services' THEN 'backups'
  WHEN storage_path LIKE '# sync inner services/%' THEN 'backups/' || substring(storage_path FROM char_length('# sync inner services/') + 1)
  WHEN storage_path='# mastermind' THEN 'mastermind'
  WHEN storage_path LIKE '# mastermind/%' THEN 'mastermind/' || substring(storage_path FROM char_length('# mastermind/') + 1)
  WHEN storage_path='# volt' THEN 'volt'
  WHEN storage_path LIKE '# volt/%' THEN 'volt/' || substring(storage_path FROM char_length('# volt/') + 1)
  WHEN storage_path='# sync windows' THEN 'sync'
  WHEN storage_path LIKE '# sync windows/%' THEN 'sync/' || substring(storage_path FROM char_length('# sync windows/') + 1)
  ELSE storage_path END,
  updated_at=now()
WHERE storage_path IN ('# drop point','# laboratory','# sync inner services','# mastermind','# volt','# sync windows')
   OR storage_path LIKE '# drop point/%' OR storage_path LIKE '# laboratory/%'
   OR storage_path LIKE '# sync inner services/%' OR storage_path LIKE '# mastermind/%'
   OR storage_path LIKE '# volt/%' OR storage_path LIKE '# sync windows/%';

UPDATE resources SET name='drop point' WHERE id='00000000-0000-7000-8000-000000000002';
UPDATE resources SET name='mastermind' WHERE id='00000000-0000-7000-8000-000000000003';
UPDATE resources SET name='sync' WHERE id='00000000-0000-7000-8000-000000000004';
UPDATE resources SET name='volt',security_classification='confidential' WHERE id='00000000-0000-7000-8000-000000000005';
UPDATE resources SET name='laboratory' WHERE id='00000000-0000-7000-8000-000000000006';
UPDATE resources SET name='backups' WHERE id='00000000-0000-7000-8000-000000000007';

UPDATE file_versions
SET storage_path = CASE
  WHEN storage_path LIKE '# drop point/%' THEN 'drop point/' || substring(storage_path FROM char_length('# drop point/') + 1)
  WHEN storage_path LIKE '# laboratory/%' THEN 'laboratory/' || substring(storage_path FROM char_length('# laboratory/') + 1)
  WHEN storage_path LIKE '# sync inner services/%' THEN 'backups/' || substring(storage_path FROM char_length('# sync inner services/') + 1)
  WHEN storage_path LIKE '# mastermind/%' THEN 'mastermind/' || substring(storage_path FROM char_length('# mastermind/') + 1)
  WHEN storage_path LIKE '# volt/%' THEN 'volt/' || substring(storage_path FROM char_length('# volt/') + 1)
  WHEN storage_path LIKE '# sync windows/%' THEN 'sync/' || substring(storage_path FROM char_length('# sync windows/') + 1)
  ELSE storage_path END
WHERE storage_path LIKE '# drop point/%' OR storage_path LIKE '# laboratory/%'
   OR storage_path LIKE '# sync inner services/%' OR storage_path LIKE '# mastermind/%'
   OR storage_path LIKE '# volt/%' OR storage_path LIKE '# sync windows/%';

UPDATE upload_sessions
SET target_path = CASE
  WHEN target_path LIKE '# drop point/%' THEN 'drop point/' || substring(target_path FROM char_length('# drop point/') + 1)
  WHEN target_path LIKE '# laboratory/%' THEN 'laboratory/' || substring(target_path FROM char_length('# laboratory/') + 1)
  WHEN target_path LIKE '# sync inner services/%' THEN 'backups/' || substring(target_path FROM char_length('# sync inner services/') + 1)
  WHEN target_path LIKE '# mastermind/%' THEN 'mastermind/' || substring(target_path FROM char_length('# mastermind/') + 1)
  WHEN target_path LIKE '# volt/%' THEN 'volt/' || substring(target_path FROM char_length('# volt/') + 1)
  WHEN target_path LIKE '# sync windows/%' THEN 'sync/' || substring(target_path FROM char_length('# sync windows/') + 1)
  ELSE target_path END,
  updated_at=now()
WHERE target_path LIKE '# drop point/%' OR target_path LIKE '# laboratory/%'
   OR target_path LIKE '# sync inner services/%' OR target_path LIKE '# mastermind/%'
   OR target_path LIKE '# volt/%' OR target_path LIKE '# sync windows/%';

UPDATE service_backup_runs
SET final_path='backups/' || substring(final_path FROM char_length('# sync inner services/') + 1),
    updated_at=now()
WHERE final_path LIKE '# sync inner services/%';

UPDATE resources
SET parent_id=NULL,status='purged',size_bytes=0,
    storage_path=CASE id
      WHEN '00000000-0000-7000-8000-000000000008' THEN '_system/orphaned/layout-v3-root-references'
      ELSE '_system/orphaned/layout-v3-root-outdoor' END,
    updated_at=now()
WHERE id IN ('00000000-0000-7000-8000-000000000008','00000000-0000-7000-8000-000000000009');

DROP TRIGGER IF EXISTS resources_path_policy ON resources;
DROP FUNCTION IF EXISTS vault_apply_resource_path_policy();
CREATE FUNCTION vault_apply_resource_path_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_path = 'volt' OR NEW.storage_path LIKE 'volt/%' THEN
    NEW.security_classification := 'confidential';
    IF NEW.type='file' AND lower(NEW.name) LIKE '%.kdbx' THEN NEW.retention_class := 'keepass'; END IF;
  ELSIF NEW.storage_path LIKE 'mastermind/%' AND NEW.type='file' THEN
    NEW.retention_class := CASE WHEN lower(NEW.name) LIKE '%.md' THEN 'mastermind_markdown' ELSE 'mastermind_attachment' END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resources_path_policy BEFORE INSERT OR UPDATE OF storage_path,name ON resources
FOR EACH ROW EXECUTE FUNCTION vault_apply_resource_path_policy();

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
    RAISE EXCEPTION 'password resources cannot be laboratory assets' USING ERRCODE='23514';
  END IF;
  IF NEW.mode LIKE 'public_%' AND selected_resource.security_classification IS DISTINCT FROM 'public' AND NEW.source_share_id IS NULL THEN
    RAISE EXCEPTION 'public laboratory asset requires public classification or a source share grant' USING ERRCODE='23514';
  END IF;
  IF NEW.source_share_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shares WHERE id=NEW.source_share_id AND resource_type='folder') THEN
    RAISE EXCEPTION 'laboratory source share is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.pinned_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM file_versions WHERE id=NEW.pinned_version_id AND resource_id=NEW.resource_id AND state='active'
  ) THEN RAISE EXCEPTION 'laboratory pinned version is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_assets_validate BEFORE INSERT OR UPDATE OF resource_id,mode,pinned_version_id,source_share_id
ON laboratory_assets FOR EACH ROW EXECUTE FUNCTION vault_validate_laboratory_asset();

UPDATE system_metadata SET value='{"version":2,"root":"subaccount-home","businessRoots":["drop point","laboratory","backups","mastermind","volt","sync"],"systemRoot":"_system"}'::jsonb,updated_at=now()
WHERE key='storage_layout';
UPDATE system_metadata SET value='{"version":1,"canonicalResourceIds":["00000000-0000-7000-8000-000000000002","00000000-0000-7000-8000-000000000003","00000000-0000-7000-8000-000000000004","00000000-0000-7000-8000-000000000005","00000000-0000-7000-8000-000000000006","00000000-0000-7000-8000-000000000007"],"canonicalMutation":"rename-only","ordinaryRootFolders":"full-control","directRootFiles":false,"systemRoot":"immutable-hidden"}'::jsonb,updated_at=now()
WHERE key='root_folder_policy';
