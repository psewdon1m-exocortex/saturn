ALTER TABLE owner_preferences
  ALTER COLUMN navigation_order SET DEFAULT '["files", "laboratory", "inbox", "shared", "trash", "activity", "settings"]'::jsonb;

UPDATE owner_preferences
SET
  navigation_order = '["files", "laboratory", "inbox", "shared", "trash", "activity", "settings"]'::jsonb,
  updated_at = now();
