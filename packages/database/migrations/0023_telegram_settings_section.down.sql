UPDATE owner_preferences AS preferences
SET
  settings_order = (
    SELECT coalesce(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
    FROM jsonb_array_elements(preferences.settings_order) WITH ORDINALITY AS item(value, ordinality)
    WHERE item.value <> '"telegram"'::jsonb
  ),
  updated_at = now();

ALTER TABLE owner_preferences
  ALTER COLUMN settings_order
    SET DEFAULT '["appearance", "security", "backup", "updates", "logs"]'::jsonb;
