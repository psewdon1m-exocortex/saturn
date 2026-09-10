ALTER TABLE owner_preferences
  ADD COLUMN upload_buffer_gib integer NOT NULL DEFAULT 110,
  ADD COLUMN maximum_upload_file_gib integer NOT NULL DEFAULT 20,
  ADD CONSTRAINT owner_preferences_upload_buffer_gib_check
    CHECK (upload_buffer_gib BETWEEN 1 AND 8192),
  ADD CONSTRAINT owner_preferences_maximum_upload_file_gib_check
    CHECK (maximum_upload_file_gib BETWEEN 1 AND 4096),
  ADD CONSTRAINT owner_preferences_upload_limits_relationship_check
    CHECK (maximum_upload_file_gib * 10 <= upload_buffer_gib * 9);
