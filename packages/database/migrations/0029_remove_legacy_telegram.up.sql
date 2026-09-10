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
    SET DEFAULT '["appearance", "security", "backup", "backup-connections", "updates", "logs"]'::jsonb;

DROP TABLE IF EXISTS telegram_updates;
DROP TABLE IF EXISTS telegram_link_challenges;
DROP TABLE IF EXISTS telegram_binding;
