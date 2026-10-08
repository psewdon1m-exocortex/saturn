DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM upload_sessions WHERE status NOT IN ('active', 'abandoned', 'failed_final')
    AND (expected_version_id IS NOT NULL OR require_absent)) THEN
    RAISE EXCEPTION 'Finish or abandon conditional uploads before downgrading transfer safety';
  END IF;
END $$;
ALTER TABLE share_packages DROP COLUMN source_fingerprint;
DROP TABLE integrity_scrub_state;
ALTER TABLE share_packages DROP COLUMN claimed_at;
ALTER TABLE drop_uploads DROP COLUMN next_attempt_at;
ALTER TABLE drop_uploads DROP COLUMN transfer_attempts;
ALTER TABLE upload_sessions DROP COLUMN require_absent;
ALTER TABLE upload_sessions DROP COLUMN expected_version_id;
