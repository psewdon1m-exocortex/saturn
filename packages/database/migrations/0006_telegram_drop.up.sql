ALTER TABLE upload_sessions
  ADD COLUMN audit_actor_type text NOT NULL DEFAULT 'owner_bootstrap',
  ADD COLUMN audit_actor_id text NOT NULL DEFAULT 'owner';

CREATE TABLE telegram_binding (
  owner_id text PRIMARY KEY CHECK (owner_id = 'owner'),
  telegram_user_id bigint NOT NULL,
  telegram_chat_id bigint NOT NULL,
  display_name text,
  bound_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE telegram_link_challenges (
  id uuid PRIMARY KEY,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('active', 'consumed', 'revoked', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT telegram_link_challenge_expiry CHECK (expires_at > created_at)
);
CREATE INDEX telegram_link_challenges_active_expiry_idx
  ON telegram_link_challenges (expires_at) WHERE state = 'active';

CREATE TABLE drop_challenges (
  id uuid PRIMARY KEY,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  telegram_user_id bigint NOT NULL,
  telegram_chat_id bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'consumed', 'revoked', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT drop_challenge_expiry CHECK (expires_at > created_at)
);
CREATE INDEX drop_challenges_active_expiry_idx
  ON drop_challenges (expires_at) WHERE state = 'active';

CREATE TABLE drop_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  user_agent_hash text NOT NULL CHECK (user_agent_hash ~ '^[a-f0-9]{64}$'),
  telegram_user_id bigint NOT NULL,
  telegram_chat_id bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  max_files integer NOT NULL CHECK (max_files BETWEEN 1 AND 100),
  max_bytes bigint NOT NULL CHECK (max_bytes > 0),
  reserved_files integer NOT NULL DEFAULT 0 CHECK (reserved_files >= 0 AND reserved_files <= max_files),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0 AND reserved_bytes <= max_bytes),
  CONSTRAINT drop_session_expiry CHECK (expires_at > created_at)
);
CREATE INDEX drop_sessions_active_expiry_idx
  ON drop_sessions (expires_at) WHERE state = 'active';

CREATE TABLE drop_uploads (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES drop_sessions(id) ON DELETE CASCADE,
  client_key_hash text NOT NULL CHECK (client_key_hash ~ '^[a-f0-9]{64}$'),
  upload_id uuid UNIQUE REFERENCES upload_sessions(id) ON DELETE SET NULL,
  resource_id uuid REFERENCES resources(id) ON DELETE SET NULL,
  filename text NOT NULL,
  expected_size bigint NOT NULL CHECK (expected_size >= 0),
  expected_sha256 text CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('reserved', 'uploading', 'completed', 'failed')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (session_id, client_key_hash)
);
CREATE INDEX drop_uploads_session_state_idx ON drop_uploads (session_id, state, created_at);

CREATE TABLE drop_attempts (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_ip_hash text NOT NULL CHECK (source_ip_hash ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('pending', 'success', 'failure', 'rate_limited')),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX drop_attempts_source_time_idx ON drop_attempts (source_ip_hash, occurred_at DESC);
CREATE INDEX drop_attempts_global_time_idx ON drop_attempts (occurred_at DESC) WHERE outcome IN ('pending', 'failure');

CREATE TABLE telegram_updates (
  update_id bigint PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  telegram_user_id bigint,
  received_at timestamptz NOT NULL,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_code text
);
CREATE INDEX telegram_updates_state_time_idx ON telegram_updates (state, received_at DESC);
