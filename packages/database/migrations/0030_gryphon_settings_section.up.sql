UPDATE owner_preferences
SET settings_order = settings_order || '["gryphon"]'::jsonb,
    updated_at = now()
WHERE NOT settings_order ? 'gryphon';

ALTER TABLE owner_preferences
  ALTER COLUMN settings_order
    SET DEFAULT '["appearance", "security", "backup", "backup-connections", "gryphon", "updates", "logs"]'::jsonb;
