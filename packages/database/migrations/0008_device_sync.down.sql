DROP TRIGGER IF EXISTS resources_path_policy ON resources;
DROP FUNCTION IF EXISTS vault_apply_resource_path_policy();
DROP TABLE IF EXISTS sync_conflicts;
DROP TABLE IF EXISTS device_delete_events;
DROP TABLE IF EXISTS devices;
DELETE FROM resources
WHERE id IN (
  '00000000-0000-7000-8000-000000000003',
  '00000000-0000-7000-8000-000000000004',
  '00000000-0000-7000-8000-000000000005'
)
AND NOT EXISTS (SELECT 1 FROM resources child WHERE child.parent_id = resources.id);
