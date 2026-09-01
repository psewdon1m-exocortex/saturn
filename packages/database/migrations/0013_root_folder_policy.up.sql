INSERT INTO resources (id, type, parent_id, name, storage_path, status, security_classification)
VALUES
  ('00000000-0000-7000-8000-000000000006', 'folder', '00000000-0000-7000-8000-000000000001', 'laboratory', 'laboratory', 'active', 'internal'),
  ('00000000-0000-7000-8000-000000000007', 'folder', '00000000-0000-7000-8000-000000000001', 'backups', 'backups', 'active', 'internal');

INSERT INTO system_metadata(key, value)
VALUES (
  'root_folder_policy',
  '{"version":1,"canonicalResourceIds":["00000000-0000-7000-8000-000000000002","00000000-0000-7000-8000-000000000003","00000000-0000-7000-8000-000000000004","00000000-0000-7000-8000-000000000005","00000000-0000-7000-8000-000000000006","00000000-0000-7000-8000-000000000007"],"canonicalMutation":"rename-only","ordinaryRootFolders":"full-control","directRootFiles":false,"systemRoot":"immutable-hidden"}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();
