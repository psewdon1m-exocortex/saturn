CREATE TABLE resources (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('file', 'folder')),
  parent_id uuid REFERENCES resources(id) DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  storage_path text NOT NULL UNIQUE,
  mime_type text,
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  current_version_id uuid,
  status text NOT NULL CHECK (status IN ('pending', 'active', 'trashed', 'missing', 'error', 'quarantined')),
  trashed_from_parent_id uuid REFERENCES resources(id) DEFERRABLE INITIALLY DEFERRED,
  trashed_from_name text,
  purge_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resources_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT resources_folder_has_no_hash CHECK (type = 'file' OR sha256 IS NULL)
);

CREATE UNIQUE INDEX resources_active_sibling_name_idx
  ON resources (parent_id, lower(name))
  WHERE status <> 'trashed';
CREATE INDEX resources_parent_idx ON resources (parent_id, name);
CREATE INDEX resources_status_idx ON resources (status, updated_at);

CREATE TABLE file_versions (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  storage_path text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  mime_type text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('initial', 'overwrite', 'sync-conflict', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE resources
  ADD CONSTRAINT resources_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES file_versions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  parent_id uuid NOT NULL REFERENCES resources(id),
  filename text NOT NULL,
  temp_path text NOT NULL UNIQUE,
  target_path text NOT NULL,
  expected_size bigint NOT NULL CHECK (expected_size >= 0),
  received_size bigint NOT NULL DEFAULT 0 CHECK (received_size >= 0),
  expected_sha256 text CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[a-f0-9]{64}$'),
  actual_sha256 text CHECK (actual_sha256 IS NULL OR actual_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN (
    'created', 'uploading', 'verifying', 'committing', 'active',
    'failed_retryable', 'failed_final', 'abandoned'
  )),
  resource_id uuid REFERENCES resources(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT upload_filename_not_blank CHECK (length(btrim(filename)) > 0),
  CONSTRAINT upload_received_not_over_expected CHECK (received_size <= expected_size)
);
CREATE INDEX upload_sessions_status_expiry_idx ON upload_sessions (status, expires_at);

CREATE TABLE operation_journal (
  id uuid PRIMARY KEY,
  operation_type text NOT NULL,
  state text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  resource_id uuid REFERENCES resources(id),
  upload_id uuid REFERENCES upload_sessions(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operation_journal_state_idx ON operation_journal (state, updated_at);

CREATE TABLE operation_locks (
  lock_key text PRIMARY KEY,
  operation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_locks_key_not_blank CHECK (length(btrim(lock_key)) > 0)
);
CREATE INDEX operation_locks_expiry_idx ON operation_locks (expires_at);

INSERT INTO resources (id, type, parent_id, name, storage_path, status)
VALUES ('00000000-0000-7000-8000-000000000001', 'folder', NULL, 'Drive', 'drive', 'active');
