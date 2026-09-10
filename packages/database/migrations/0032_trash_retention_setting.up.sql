ALTER TABLE owner_preferences
  ADD COLUMN trash_retention_days integer NOT NULL DEFAULT 30
  CHECK (trash_retention_days BETWEEN 1 AND 365);
