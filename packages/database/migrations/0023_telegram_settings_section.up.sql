ALTER TABLE owner_preferences
  ALTER COLUMN settings_order
    SET DEFAULT '["appearance", "security", "telegram", "backup", "updates", "logs"]'::jsonb;

UPDATE owner_preferences AS preferences
SET
  settings_order = (
    SELECT jsonb_agg(ordered.item ORDER BY ordered.position)
    FROM (
      SELECT item.value AS item, item.ordinality::numeric AS position
      FROM jsonb_array_elements(preferences.settings_order) WITH ORDINALITY AS item(value, ordinality)
      UNION ALL
      SELECT
        '"telegram"'::jsonb,
        coalesce(
          (
            SELECT existing.ordinality::numeric + 0.5
            FROM jsonb_array_elements_text(preferences.settings_order) WITH ORDINALITY AS existing(value, ordinality)
            WHERE existing.value = 'security'
          ),
          jsonb_array_length(preferences.settings_order)::numeric + 1
        )
    ) AS ordered
  ),
  updated_at = now()
WHERE NOT settings_order ? 'telegram';
