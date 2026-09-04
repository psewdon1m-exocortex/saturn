CREATE TABLE drop_channels (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  created_at timestamptz NOT NULL,
  activated_at timestamptz,
  expires_at timestamptz NOT NULL,
  max_files integer NOT NULL CHECK (max_files BETWEEN 1 AND 10000),
  max_bytes bigint NOT NULL CHECK (max_bytes > 0),
  reserved_files integer NOT NULL DEFAULT 0 CHECK (reserved_files >= 0 AND reserved_files <= max_files),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0 AND reserved_bytes <= max_bytes),
  CONSTRAINT drop_channel_expiry CHECK (expires_at > created_at)
);
CREATE INDEX drop_channels_active_expiry_idx ON drop_channels (expires_at) WHERE state = 'active';

INSERT INTO drop_channels (
  id, state, created_at, activated_at, expires_at, max_files, max_bytes, reserved_files, reserved_bytes
)
SELECT id, state, created_at, created_at, expires_at, max_files, max_bytes, reserved_files, reserved_bytes
FROM drop_sessions;

INSERT INTO drop_channels (
  id, state, created_at, activated_at, expires_at, max_files, max_bytes, reserved_files, reserved_bytes
)
SELECT id,
  CASE state WHEN 'active' THEN 'active' WHEN 'expired' THEN 'expired' ELSE 'revoked' END,
  created_at, consumed_at, expires_at, 10000, 9007199254740991, 0, 0
FROM drop_challenges
ON CONFLICT (id) DO NOTHING;

ALTER TABLE drop_challenges ADD COLUMN channel_id uuid;
UPDATE drop_challenges SET channel_id = id;
ALTER TABLE drop_challenges ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE drop_challenges
  ADD CONSTRAINT drop_challenges_channel_fk FOREIGN KEY (channel_id) REFERENCES drop_channels(id);

ALTER TABLE drop_sessions ADD COLUMN channel_id uuid;
UPDATE drop_sessions SET channel_id = id;
ALTER TABLE drop_sessions ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE drop_sessions
  ADD CONSTRAINT drop_sessions_channel_fk FOREIGN KEY (channel_id) REFERENCES drop_channels(id);
CREATE INDEX drop_sessions_channel_idx ON drop_sessions (channel_id, state, created_at);

ALTER TABLE drop_uploads ADD COLUMN channel_id uuid;
UPDATE drop_uploads SET channel_id = session_id;
ALTER TABLE drop_uploads ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE drop_uploads
  ADD CONSTRAINT drop_uploads_channel_fk FOREIGN KEY (channel_id) REFERENCES drop_channels(id);
ALTER TABLE drop_uploads
  ADD CONSTRAINT drop_uploads_channel_client_key_unique UNIQUE (channel_id, client_key_hash);
CREATE INDEX drop_uploads_channel_state_idx ON drop_uploads (channel_id, state, created_at);
