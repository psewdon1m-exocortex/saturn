UPDATE owner_preferences
SET
  dashboard_order = '["cpu", "ram", "disk", "uptime"]'::jsonb,
  updated_at = now()
WHERE dashboard_order = '["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"]'::jsonb;

ALTER TABLE owner_preferences
  ALTER COLUMN dashboard_order
    SET DEFAULT '["cpu", "ram", "disk", "uptime"]'::jsonb;
