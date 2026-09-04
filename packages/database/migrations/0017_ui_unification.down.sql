ALTER TABLE owner_preferences
  ALTER COLUMN navigation_order
    SET DEFAULT '["files", "inbox", "shared", "trash", "settings"]'::jsonb;

DROP TABLE kernel_settings;
DROP TABLE owner_credentials;

UPDATE owner_preferences
SET
  navigation_order = (
    SELECT coalesce(jsonb_agg(destination ORDER BY ordinal), '[]'::jsonb)
    FROM jsonb_array_elements_text(navigation_order) WITH ORDINALITY AS item(destination, ordinal)
    WHERE destination <> 'dashboard'
  ),
  updated_at = now();

ALTER TABLE owner_preferences
  DROP COLUMN settings_order,
  DROP COLUMN dashboard_order;
