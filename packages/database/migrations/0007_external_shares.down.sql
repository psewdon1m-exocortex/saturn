DROP TRIGGER IF EXISTS share_access_events_no_update ON share_access_events;
DROP FUNCTION IF EXISTS vault_share_access_immutable;
DROP TABLE IF EXISTS share_access_events;
DROP TABLE IF EXISTS share_packages;
DROP TABLE IF EXISTS share_password_attempts;
DROP TABLE IF EXISTS share_sessions;
DROP TABLE IF EXISTS shares;
ALTER TABLE resources DROP COLUMN IF EXISTS security_classification;
