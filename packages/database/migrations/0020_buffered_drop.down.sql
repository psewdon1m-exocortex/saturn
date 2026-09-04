DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drop_uploads WHERE state IN ('reserved', 'uploading', 'buffered', 'transferring', 'verifying')) THEN
    RAISE EXCEPTION 'Cannot roll back buffered Drop while uncommitted uploads exist';
  END IF;
END $$;

DROP INDEX IF EXISTS drop_uploads_buffer_queue_idx;
ALTER TABLE drop_uploads DROP CONSTRAINT drop_uploads_local_path_required;
ALTER TABLE drop_uploads DROP CONSTRAINT drop_uploads_received_bound;
ALTER TABLE drop_uploads DROP CONSTRAINT drop_uploads_state_check;

UPDATE drop_uploads SET state = 'completed' WHERE state = 'stored';
DELETE FROM drop_uploads WHERE state IN ('failed', 'cancelled');

ALTER TABLE drop_uploads ADD CONSTRAINT drop_uploads_state_check CHECK (state IN ('reserved', 'uploading', 'completed', 'failed'));
ALTER TABLE drop_uploads
  DROP COLUMN continuation_until,
  DROP COLUMN transfer_started_at,
  DROP COLUMN updated_at,
  DROP COLUMN failure_code,
  DROP COLUMN actual_sha256,
  DROP COLUMN received_size,
  DROP COLUMN local_path;

ALTER TABLE drop_sessions DROP CONSTRAINT drop_sessions_max_files_check;
ALTER TABLE drop_sessions ADD CONSTRAINT drop_sessions_max_files_check CHECK (max_files BETWEEN 1 AND 100);
