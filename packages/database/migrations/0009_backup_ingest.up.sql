CREATE TABLE backup_services (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  previous_token_hash text CHECK (previous_token_hash IS NULL OR previous_token_hash ~ '^[a-f0-9]{64}$'),
  previous_token_expires_at timestamptz,
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  require_encryption boolean NOT NULL,
  mtls_cert_fingerprint text CHECK (mtls_cert_fingerprint IS NULL OR mtls_cert_fingerprint ~ '^[a-f0-9]{64}$'),
  max_backup_bytes bigint NOT NULL CHECK (max_backup_bytes > 0),
  daily_quota_bytes bigint NOT NULL CHECK (daily_quota_bytes >= max_backup_bytes),
  stored_quota_bytes bigint NOT NULL CHECK (stored_quota_bytes >= max_backup_bytes),
  max_concurrent_runs integer NOT NULL CHECK (max_concurrent_runs BETWEEN 1 AND 32),
  freshness_sla_ms bigint NOT NULL CHECK (freshness_sla_ms >= 60000),
  retention_daily integer NOT NULL CHECK (retention_daily BETWEEN 0 AND 366),
  retention_weekly integer NOT NULL CHECK (retention_weekly BETWEEN 0 AND 260),
  retention_monthly integer NOT NULL CHECK (retention_monthly BETWEEN 0 AND 1200),
  retention_yearly integer NOT NULL CHECK (retention_yearly BETWEEN 0 AND 100),
  last_used_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK ((previous_token_hash IS NULL) = (previous_token_expires_at IS NULL))
);
CREATE UNIQUE INDEX backup_services_previous_token_hash_idx
  ON backup_services(previous_token_hash) WHERE previous_token_hash IS NOT NULL;
CREATE INDEX backup_services_state_idx ON backup_services(state, created_at DESC);

CREATE TABLE service_backup_runs (
  id uuid PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES backup_services(id),
  client_key_hash text NOT NULL CHECK (client_key_hash ~ '^[a-f0-9]{64}$'),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  source_created_at timestamptz NOT NULL,
  backup_type text NOT NULL CHECK (backup_type ~ '^[a-z][a-z0-9_-]{0,31}$'),
  expected_size bigint NOT NULL CHECK (expected_size > 0),
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 200),
  encrypted boolean NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'uploading', 'appending', 'verifying', 'complete', 'failed')),
  received_size bigint NOT NULL DEFAULT 0 CHECK (received_size >= 0 AND received_size <= expected_size),
  temp_path text NOT NULL,
  final_path text NOT NULL,
  receipt jsonb,
  failure_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  committed_at timestamptz,
  UNIQUE (service_id, client_key_hash),
  CHECK ((state = 'complete') = (receipt IS NOT NULL AND committed_at IS NOT NULL))
);
CREATE INDEX service_backup_runs_service_created_idx ON service_backup_runs(service_id, created_at DESC);
CREATE INDEX service_backup_runs_active_idx ON service_backup_runs(service_id, state, created_at)
  WHERE state IN ('pending', 'uploading', 'appending', 'verifying');

CREATE TABLE service_backup_restore_tests (
  id uuid PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES backup_services(id),
  run_id uuid NOT NULL REFERENCES service_backup_runs(id),
  method text NOT NULL CHECK (method IN ('integrity_check', 'isolated_restore')),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  artifact_sha256 text CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL
);
CREATE INDEX service_backup_restore_tests_service_idx
  ON service_backup_restore_tests(service_id, completed_at DESC);

