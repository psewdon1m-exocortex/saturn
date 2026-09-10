ALTER TABLE owner_preferences
  ALTER COLUMN navigation_order
  SET DEFAULT '["dashboard", "files", "inbox", "shared", "synchronization", "trash", "settings"]'::jsonb;

UPDATE owner_preferences AS preferences
SET navigation_order = (
  SELECT coalesce(jsonb_agg(item.value ORDER BY item.ordinal), '[]'::jsonb)
  FROM (
    SELECT value, ordinality::numeric AS ordinal
    FROM jsonb_array_elements(preferences.navigation_order) WITH ORDINALITY AS existing(value, ordinality)
    WHERE value <> '"synchronization"'::jsonb
    UNION ALL
    SELECT '"synchronization"'::jsonb,
      coalesce((
        SELECT ordinality::numeric - 0.5
        FROM jsonb_array_elements_text(preferences.navigation_order) WITH ORDINALITY AS existing(value, ordinality)
        WHERE value = 'trash'
        LIMIT 1
      ), jsonb_array_length(preferences.navigation_order)::numeric + 1)
  ) AS item
),
settings_order = (
  SELECT coalesce(jsonb_agg(value ORDER BY ordinality), '[]'::jsonb)
  FROM jsonb_array_elements(preferences.settings_order) WITH ORDINALITY AS item(value, ordinality)
  WHERE value <> '"backup-connections"'::jsonb
),
updated_at = now();

ALTER TABLE owner_preferences
  ALTER COLUMN settings_order
  SET DEFAULT '["appearance", "security", "backup", "gryphon", "updates", "logs"]'::jsonb;
