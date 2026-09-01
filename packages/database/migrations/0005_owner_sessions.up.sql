CREATE TABLE web_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  source_ip_hash text NOT NULL CHECK (source_ip_hash ~ '^[a-f0-9]{64}$'),
  user_agent_hash text NOT NULL CHECK (user_agent_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  reauthenticated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT web_sessions_expiry_order CHECK (idle_expires_at <= expires_at)
);
CREATE INDEX web_sessions_active_expiry_idx
  ON web_sessions (idle_expires_at, expires_at) WHERE state = 'active';

CREATE TABLE auth_attempts (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_ip_hash text NOT NULL CHECK (source_ip_hash ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'rate_limited')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_source_time_idx
  ON auth_attempts (source_ip_hash, occurred_at DESC);

CREATE TABLE owner_preferences (
  owner_id text PRIMARY KEY CHECK (owner_id = 'owner'),
  dark_color text NOT NULL DEFAULT '#000000' CHECK (dark_color ~ '^#[0-9a-fA-F]{6}$'),
  light_color text NOT NULL DEFAULT '#ffffff' CHECK (light_color ~ '^#[0-9a-fA-F]{6}$'),
  accent_color text NOT NULL DEFAULT '#00a8ff' CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO owner_preferences (owner_id) VALUES ('owner');

INSERT INTO resources (id, type, parent_id, name, storage_path, status)
VALUES (
  '00000000-0000-7000-8000-000000000002',
  'folder',
  '00000000-0000-7000-8000-000000000001',
  'Inbox',
  'drive/Inbox',
  'active'
)
ON CONFLICT (id) DO NOTHING;
