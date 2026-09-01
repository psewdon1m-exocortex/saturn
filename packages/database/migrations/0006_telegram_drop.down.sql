DROP TABLE IF EXISTS telegram_updates;
DROP TABLE IF EXISTS drop_attempts;
DROP TABLE IF EXISTS drop_uploads;
DROP TABLE IF EXISTS drop_sessions;
DROP TABLE IF EXISTS drop_challenges;
DROP TABLE IF EXISTS telegram_link_challenges;
DROP TABLE IF EXISTS telegram_binding;
ALTER TABLE upload_sessions
  DROP COLUMN IF EXISTS audit_actor_id,
  DROP COLUMN IF EXISTS audit_actor_type;
