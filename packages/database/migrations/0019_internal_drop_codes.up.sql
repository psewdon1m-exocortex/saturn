ALTER TABLE drop_challenges
  ALTER COLUMN telegram_user_id DROP NOT NULL,
  ALTER COLUMN telegram_chat_id DROP NOT NULL,
  ADD CONSTRAINT drop_challenge_telegram_identity_pair
    CHECK ((telegram_user_id IS NULL) = (telegram_chat_id IS NULL));

ALTER TABLE drop_sessions
  ALTER COLUMN telegram_user_id DROP NOT NULL,
  ALTER COLUMN telegram_chat_id DROP NOT NULL,
  ADD CONSTRAINT drop_session_telegram_identity_pair
    CHECK ((telegram_user_id IS NULL) = (telegram_chat_id IS NULL));
