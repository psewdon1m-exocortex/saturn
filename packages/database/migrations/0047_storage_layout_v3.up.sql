DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM resources
    WHERE (id, storage_path) NOT IN (
      ('00000000-0000-7000-8000-000000000001'::uuid, ''),
      ('00000000-0000-7000-8000-000000000002'::uuid, 'drop point'),
      ('00000000-0000-7000-8000-000000000003'::uuid, 'mastermind'),
      ('00000000-0000-7000-8000-000000000004'::uuid, 'sync'),
      ('00000000-0000-7000-8000-000000000005'::uuid, 'volt'),
      ('00000000-0000-7000-8000-000000000006'::uuid, 'laboratory'),
      ('00000000-0000-7000-8000-000000000007'::uuid, 'backups')
    )
    AND id IN (
      '00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000002',
      '00000000-0000-7000-8000-000000000003','00000000-0000-7000-8000-000000000004',
      '00000000-0000-7000-8000-000000000005','00000000-0000-7000-8000-000000000006',
      '00000000-0000-7000-8000-000000000007'
    )
  ) THEN
    RAISE EXCEPTION 'storage layout v3 requires the canonical v2 production root paths';
  END IF;
  IF EXISTS (
    SELECT 1 FROM resources
    WHERE storage_path = ANY(ARRAY[
      '# drop point','# laboratory','# sync inner services','# mastermind',
      '# volt','# sync windows','# sync outdoor connections','# references'
    ])
      AND id NOT IN ('00000000-0000-7000-8000-000000000008','00000000-0000-7000-8000-000000000009')
  ) THEN
    RAISE EXCEPTION 'storage layout v3 target path collision';
  END IF;
  IF EXISTS (SELECT 1 FROM resources WHERE storage_path LIKE 'backups/pluto/%')
     AND NOT EXISTS (
       SELECT 1 FROM resources
       WHERE parent_id='00000000-0000-7000-8000-000000000007'
         AND name='pluto' AND storage_path='backups/pluto' AND type='folder' AND status='active'
     ) THEN
    RAISE EXCEPTION 'Pluto resources have no canonical v2 container';
  END IF;
END $$;

CREATE TEMP TABLE saturn_layout_v3_pluto ON COMMIT DROP AS
SELECT id, size_bytes
FROM resources
WHERE parent_id='00000000-0000-7000-8000-000000000007'
  AND name='pluto' AND storage_path='backups/pluto' AND type='folder' AND status='active';

INSERT INTO resources (id,type,parent_id,name,storage_path,size_bytes,status,security_classification)
VALUES
  ('00000000-0000-7000-8000-000000000008','folder','00000000-0000-7000-8000-000000000001','# references','# references',0,'active','internal'),
  ('00000000-0000-7000-8000-000000000009','folder','00000000-0000-7000-8000-000000000001','# sync outdoor connections','# sync outdoor connections',
    COALESCE((SELECT size_bytes FROM saturn_layout_v3_pluto LIMIT 1),0),'active','internal')
ON CONFLICT (id) DO UPDATE SET
  parent_id=EXCLUDED.parent_id,name=EXCLUDED.name,storage_path=EXCLUDED.storage_path,
  size_bytes=EXCLUDED.size_bytes,status='active',security_classification='internal',
  trashed_from_parent_id=NULL,trashed_from_name=NULL,purge_after=NULL,updated_at=now();

UPDATE resources
SET storage_path = '# sync outdoor connections/' || substring(storage_path FROM char_length('backups/pluto/') + 1),
    parent_id = CASE WHEN parent_id IN (SELECT id FROM saturn_layout_v3_pluto)
      THEN '00000000-0000-7000-8000-000000000009'::uuid ELSE parent_id END,
    updated_at=now()
WHERE storage_path LIKE 'backups/pluto/%';

UPDATE file_versions
SET storage_path = '# sync outdoor connections/' || substring(storage_path FROM char_length('backups/pluto/') + 1)
WHERE storage_path LIKE 'backups/pluto/%';

UPDATE upload_sessions
SET target_path = '# sync outdoor connections/' || substring(target_path FROM char_length('backups/pluto/') + 1),
    updated_at=now()
WHERE target_path LIKE 'backups/pluto/%';

UPDATE resources
SET parent_id=NULL, storage_path='_system/orphaned/layout-v3-pluto-' || id::text,
    size_bytes=0, status='purged', updated_at=now()
WHERE id IN (SELECT id FROM saturn_layout_v3_pluto);

UPDATE resources SET size_bytes=GREATEST(0,size_bytes-COALESCE((SELECT size_bytes FROM saturn_layout_v3_pluto LIMIT 1),0))
WHERE id='00000000-0000-7000-8000-000000000007';

UPDATE resources
SET storage_path = CASE
  WHEN storage_path='drop point' THEN '# drop point'
  WHEN storage_path LIKE 'drop point/%' THEN '# drop point/' || substring(storage_path FROM char_length('drop point/') + 1)
  WHEN storage_path='laboratory' THEN '# laboratory'
  WHEN storage_path LIKE 'laboratory/%' THEN '# laboratory/' || substring(storage_path FROM char_length('laboratory/') + 1)
  WHEN storage_path='backups' THEN '# sync inner services'
  WHEN storage_path LIKE 'backups/%' THEN '# sync inner services/' || substring(storage_path FROM char_length('backups/') + 1)
  WHEN storage_path='mastermind' THEN '# mastermind'
  WHEN storage_path LIKE 'mastermind/%' THEN '# mastermind/' || substring(storage_path FROM char_length('mastermind/') + 1)
  WHEN storage_path='volt' THEN '# volt'
  WHEN storage_path LIKE 'volt/%' THEN '# volt/' || substring(storage_path FROM char_length('volt/') + 1)
  WHEN storage_path='sync' THEN '# sync windows'
  WHEN storage_path LIKE 'sync/%' THEN '# sync windows/' || substring(storage_path FROM char_length('sync/') + 1)
  ELSE storage_path END,
  updated_at=now()
WHERE storage_path IN ('drop point','laboratory','backups','mastermind','volt','sync')
   OR storage_path LIKE 'drop point/%' OR storage_path LIKE 'laboratory/%'
   OR storage_path LIKE 'backups/%' OR storage_path LIKE 'mastermind/%'
   OR storage_path LIKE 'volt/%' OR storage_path LIKE 'sync/%';

UPDATE resources SET name='# drop point' WHERE id='00000000-0000-7000-8000-000000000002';
UPDATE resources SET name='# mastermind' WHERE id='00000000-0000-7000-8000-000000000003';
UPDATE resources SET name='# sync windows' WHERE id='00000000-0000-7000-8000-000000000004';
UPDATE resources SET name='# volt',security_classification='confidential' WHERE id='00000000-0000-7000-8000-000000000005';
UPDATE resources SET name='# laboratory' WHERE id='00000000-0000-7000-8000-000000000006';
UPDATE resources SET name='# sync inner services' WHERE id='00000000-0000-7000-8000-000000000007';

UPDATE file_versions
SET storage_path = CASE
  WHEN storage_path LIKE 'drop point/%' THEN '# drop point/' || substring(storage_path FROM char_length('drop point/') + 1)
  WHEN storage_path LIKE 'laboratory/%' THEN '# laboratory/' || substring(storage_path FROM char_length('laboratory/') + 1)
  WHEN storage_path LIKE 'backups/%' THEN '# sync inner services/' || substring(storage_path FROM char_length('backups/') + 1)
  WHEN storage_path LIKE 'mastermind/%' THEN '# mastermind/' || substring(storage_path FROM char_length('mastermind/') + 1)
  WHEN storage_path LIKE 'volt/%' THEN '# volt/' || substring(storage_path FROM char_length('volt/') + 1)
  WHEN storage_path LIKE 'sync/%' THEN '# sync windows/' || substring(storage_path FROM char_length('sync/') + 1)
  ELSE storage_path END
WHERE storage_path LIKE 'drop point/%' OR storage_path LIKE 'laboratory/%'
   OR storage_path LIKE 'backups/%' OR storage_path LIKE 'mastermind/%'
   OR storage_path LIKE 'volt/%' OR storage_path LIKE 'sync/%';

UPDATE upload_sessions
SET target_path = CASE
  WHEN target_path LIKE 'drop point/%' THEN '# drop point/' || substring(target_path FROM char_length('drop point/') + 1)
  WHEN target_path LIKE 'laboratory/%' THEN '# laboratory/' || substring(target_path FROM char_length('laboratory/') + 1)
  WHEN target_path LIKE 'backups/%' THEN '# sync inner services/' || substring(target_path FROM char_length('backups/') + 1)
  WHEN target_path LIKE 'mastermind/%' THEN '# mastermind/' || substring(target_path FROM char_length('mastermind/') + 1)
  WHEN target_path LIKE 'volt/%' THEN '# volt/' || substring(target_path FROM char_length('volt/') + 1)
  WHEN target_path LIKE 'sync/%' THEN '# sync windows/' || substring(target_path FROM char_length('sync/') + 1)
  ELSE target_path END,
  updated_at=now()
WHERE target_path LIKE 'drop point/%' OR target_path LIKE 'laboratory/%'
   OR target_path LIKE 'backups/%' OR target_path LIKE 'mastermind/%'
   OR target_path LIKE 'volt/%' OR target_path LIKE 'sync/%';

UPDATE service_backup_runs
SET final_path='# sync inner services/' || substring(final_path FROM char_length('backups/') + 1),
    updated_at=now()
WHERE final_path LIKE 'backups/%';

-- Receipt paths are a public protocol namespace, not physical storage paths.
-- Keep /backups stable so deployed producers do not need a coordinated update.
UPDATE service_backup_runs
SET receipt=jsonb_set(receipt,'{logicalPath}',to_jsonb('/backups/' || substring(receipt->>'logicalPath' FROM char_length('/# sync inner services/') + 1))),
    updated_at=now()
WHERE receipt IS NOT NULL AND receipt->>'logicalPath' LIKE '/# sync inner services/%';

DROP TRIGGER IF EXISTS resources_path_policy ON resources;
DROP FUNCTION IF EXISTS vault_apply_resource_path_policy();
CREATE FUNCTION vault_apply_resource_path_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_path = '# volt' OR NEW.storage_path LIKE '# volt/%' THEN
    NEW.security_classification := 'confidential';
    IF NEW.type='file' AND lower(NEW.name) LIKE '%.kdbx' THEN NEW.retention_class := 'keepass'; END IF;
  ELSIF NEW.storage_path LIKE '# mastermind/%' AND NEW.type='file' THEN
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
  IF selected_resource.storage_path = '# volt' OR selected_resource.storage_path LIKE '# volt/%' THEN
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

INSERT INTO system_metadata(key,value) VALUES
('storage_layout','{"version":3,"root":"subaccount-home","businessRoots":["# drop point","# laboratory","# sync inner services","# mastermind","# volt","# sync windows","# sync outdoor connections","# references"],"systemRoot":"_system","plutoConnectionsDirect":true}'::jsonb),
('root_folder_policy','{"version":2,"canonicalResourceIds":["00000000-0000-7000-8000-000000000002","00000000-0000-7000-8000-000000000003","00000000-0000-7000-8000-000000000004","00000000-0000-7000-8000-000000000005","00000000-0000-7000-8000-000000000006","00000000-0000-7000-8000-000000000007","00000000-0000-7000-8000-000000000008","00000000-0000-7000-8000-000000000009"],"canonicalMutation":"immutable","ordinaryRootFolders":"full-control","directRootFiles":false,"systemRoot":"immutable-hidden"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
