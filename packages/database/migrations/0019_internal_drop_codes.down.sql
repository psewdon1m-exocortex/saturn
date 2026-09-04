DELETE FROM drop_uploads
WHERE session_id IN (
  SELECT id FROM drop_sessions WHERE telegram_user_id IS NULL
);
DELETE FROM drop_sessions WHERE telegram_user_id IS NULL;
DELETE FROM drop_challenges WHERE telegram_user_id IS NULL;

ALTER TABLE drop_sessions
  DROP CONSTRAINT drop_session_telegram_identity_pair,
  ALTER COLUMN telegram_user_id SET NOT NULL,
  ALTER COLUMN telegram_chat_id SET NOT NULL;

ALTER TABLE drop_challenges
  DROP CONSTRAINT drop_challenge_telegram_identity_pair,
  ALTER COLUMN telegram_user_id SET NOT NULL,
  ALTER COLUMN telegram_chat_id SET NOT NULL;
