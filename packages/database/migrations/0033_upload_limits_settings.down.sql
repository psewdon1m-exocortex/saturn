ALTER TABLE owner_preferences
  DROP CONSTRAINT IF EXISTS owner_preferences_upload_limits_relationship_check,
  DROP CONSTRAINT IF EXISTS owner_preferences_maximum_upload_file_gib_check,
  DROP CONSTRAINT IF EXISTS owner_preferences_upload_buffer_gib_check,
  DROP COLUMN IF EXISTS maximum_upload_file_gib,
  DROP COLUMN IF EXISTS upload_buffer_gib;
