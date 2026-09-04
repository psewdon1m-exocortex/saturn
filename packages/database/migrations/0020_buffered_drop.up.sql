ALTER TABLE drop_sessions DROP CONSTRAINT drop_sessions_max_files_check;
ALTER TABLE drop_sessions ADD CONSTRAINT drop_sessions_max_files_check CHECK (max_files BETWEEN 1 AND 10000);

ALTER TABLE drop_uploads
  ADD COLUMN local_path text,
  ADD COLUMN received_size bigint NOT NULL DEFAULT 0 CHECK (received_size >= 0),
  ADD COLUMN actual_sha256 text CHECK (actual_sha256 IS NULL OR actual_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN failure_code text,
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN transfer_started_at timestamptz,
  ADD COLUMN continuation_until timestamptz;

ALTER TABLE drop_uploads DROP CONSTRAINT drop_uploads_state_check;

UPDATE drop_uploads
SET state = 'stored',
    received_size = expected_size,
    updated_at = COALESCE(completed_at, created_at),
    continuation_until = created_at
WHERE state = 'completed';

UPDATE drop_uploads
SET updated_at = created_at,
    continuation_until = created_at + interval '24 hours'
WHERE updated_at IS NULL;

ALTER TABLE drop_uploads ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE drop_uploads ALTER COLUMN continuation_until SET NOT NULL;
ALTER TABLE drop_uploads ADD CONSTRAINT drop_uploads_state_check CHECK (
  state IN ('reserved', 'uploading', 'buffered', 'transferring', 'verifying', 'stored', 'failed', 'cancelled')
);
ALTER TABLE drop_uploads ADD CONSTRAINT drop_uploads_received_bound CHECK (received_size <= expected_size);
ALTER TABLE drop_uploads ADD CONSTRAINT drop_uploads_local_path_required CHECK (
  state IN ('reserved', 'stored', 'failed', 'cancelled') OR local_path IS NOT NULL
);

DROP INDEX drop_uploads_session_state_idx;
CREATE INDEX drop_uploads_session_state_idx ON drop_uploads (session_id, state, created_at);
CREATE INDEX drop_uploads_buffer_queue_idx ON drop_uploads (created_at, id) WHERE state = 'buffered';
