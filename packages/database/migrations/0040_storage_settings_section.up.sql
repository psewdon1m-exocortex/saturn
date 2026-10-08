ALTER TABLE owner_preferences
  ALTER COLUMN settings_order
    SET DEFAULT '["appearance", "security", "storage", "backup", "gryphon", "updates", "logs"]'::jsonb;

UPDATE owner_preferences AS preferences
SET settings_order = (
  SELECT jsonb_agg(item.value ORDER BY item.ordinal)
  FROM (
    SELECT value, ordinality::numeric AS ordinal
    FROM jsonb_array_elements(preferences.settings_order) WITH ORDINALITY AS existing(value, ordinality)
    UNION ALL
    SELECT '"storage"'::jsonb,
      coalesce((
        SELECT ordinality::numeric + 0.5
        FROM jsonb_array_elements_text(preferences.settings_order) WITH ORDINALITY AS existing(value, ordinality)
        WHERE value = 'security'
        LIMIT 1
      ), jsonb_array_length(preferences.settings_order)::numeric + 1)
  ) AS item
), updated_at = now()
WHERE NOT settings_order ? 'storage';
