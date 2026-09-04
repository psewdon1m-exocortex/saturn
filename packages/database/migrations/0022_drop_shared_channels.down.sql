UPDATE drop_challenges
SET state = 'consumed'
WHERE state = 'active' AND consumed_at IS NOT NULL;

DROP INDEX IF EXISTS drop_uploads_channel_state_idx;
ALTER TABLE drop_uploads DROP CONSTRAINT IF EXISTS drop_uploads_channel_client_key_unique;
ALTER TABLE drop_uploads DROP CONSTRAINT IF EXISTS drop_uploads_channel_fk;
ALTER TABLE drop_uploads DROP COLUMN IF EXISTS channel_id;

DROP INDEX IF EXISTS drop_sessions_channel_idx;
ALTER TABLE drop_sessions DROP CONSTRAINT IF EXISTS drop_sessions_channel_fk;
ALTER TABLE drop_sessions DROP COLUMN IF EXISTS channel_id;

ALTER TABLE drop_challenges DROP CONSTRAINT IF EXISTS drop_challenges_channel_fk;
ALTER TABLE drop_challenges DROP COLUMN IF EXISTS channel_id;

DROP INDEX IF EXISTS drop_channels_active_expiry_idx;
DROP TABLE drop_channels;
