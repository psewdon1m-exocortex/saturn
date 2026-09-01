DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM resources
    WHERE parent_id IN (
      '00000000-0000-7000-8000-000000000006',
      '00000000-0000-7000-8000-000000000007'
    )
  ) THEN
    RAISE EXCEPTION 'root folder policy rollback requires empty laboratory and backups resource roots';
  END IF;
END $$;

DELETE FROM resources
WHERE id IN (
  '00000000-0000-7000-8000-000000000006',
  '00000000-0000-7000-8000-000000000007'
);

DELETE FROM system_metadata WHERE key = 'root_folder_policy';
