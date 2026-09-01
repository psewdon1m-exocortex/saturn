ALTER TABLE resources
  ADD COLUMN security_classification text NOT NULL DEFAULT 'internal'
  CHECK (security_classification IN ('public', 'internal', 'confidential', 'secret'));

CREATE TABLE shares (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  resource_id uuid NOT NULL REFERENCES resources(id),
  resource_type text NOT NULL CHECK (resource_type IN ('file', 'folder')),
  mode text NOT NULL CHECK (mode IN ('view', 'download', 'browse', 'download_folder')),
  state text NOT NULL CHECK (state IN ('active', 'revoked', 'expired', 'exhausted')),
  password_hash text,
  expires_at timestamptz,
  max_downloads integer CHECK (max_downloads IS NULL OR max_downloads BETWEEN 1 AND 1000000),
  download_count integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  allowed_cidr cidr,
  classification_ceiling text NOT NULL CHECK (classification_ceiling IN ('public', 'internal')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (
    (resource_type = 'file' AND mode IN ('view', 'download')) OR
    (resource_type = 'folder' AND mode IN ('browse', 'download_folder'))
  ),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (download_count <= COALESCE(max_downloads, download_count))
);
CREATE INDEX shares_resource_state_idx ON shares (resource_id, state, updated_at DESC);
CREATE INDEX shares_expiry_idx ON shares (expires_at) WHERE state = 'active' AND expires_at IS NOT NULL;

CREATE TABLE share_sessions (
  id uuid PRIMARY KEY,
  share_id uuid NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  source_ip_hash text NOT NULL CHECK (source_ip_hash ~ '^[a-f0-9]{64}$'),
  user_agent_hash text NOT NULL CHECK (user_agent_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  download_claimed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX share_sessions_share_state_idx ON share_sessions (share_id, state, expires_at);

CREATE TABLE share_password_attempts (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_ip_hash text NOT NULL CHECK (source_ip_hash ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('pending', 'success', 'failure', 'rate_limited')),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX share_password_attempts_source_time_idx
  ON share_password_attempts (source_ip_hash, occurred_at DESC)
  WHERE outcome IN ('pending', 'failure');

CREATE TABLE share_packages (
  id uuid PRIMARY KEY,
  share_id uuid NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('preparing', 'ready', 'failed', 'expired')),
  storage_path text NOT NULL UNIQUE,
  file_count integer NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  ready_at timestamptz,
  expires_at timestamptz NOT NULL,
  error_code text,
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX share_packages_one_current_idx ON share_packages (share_id)
  WHERE state IN ('preparing', 'ready');
CREATE INDEX share_packages_cleanup_idx ON share_packages (expires_at, state);

CREATE TABLE share_access_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  share_id uuid REFERENCES shares(id) ON DELETE SET NULL,
  source_ip_hash text NOT NULL CHECK (source_ip_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('metadata', 'unlock', 'browse', 'content', 'package_create', 'package_content')),
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  status_code integer NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  range_start bigint,
  range_length bigint,
  occurred_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX share_access_events_share_time_idx ON share_access_events (share_id, occurred_at DESC);

CREATE FUNCTION vault_share_access_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'share access events are append-only';
END;
$$;
CREATE TRIGGER share_access_events_no_update
  BEFORE UPDATE OR DELETE ON share_access_events
  FOR EACH ROW EXECUTE FUNCTION vault_share_access_immutable();
