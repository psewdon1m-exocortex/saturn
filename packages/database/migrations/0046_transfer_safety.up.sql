ALTER TABLE upload_sessions ADD COLUMN expected_version_id uuid;
ALTER TABLE upload_sessions ADD COLUMN require_absent boolean NOT NULL DEFAULT false;
ALTER TABLE drop_uploads ADD COLUMN transfer_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE drop_uploads ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE share_packages ADD COLUMN source_fingerprint text;
ALTER TABLE share_packages ADD COLUMN claimed_at timestamptz;
-- Existing cached ZIPs have no membership fingerprint and must be rebuilt.
UPDATE share_packages SET state='expired' WHERE state IN ('preparing', 'ready');
CREATE TABLE integrity_scrub_state (id boolean PRIMARY KEY DEFAULT true CHECK (id), last_version_id text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO integrity_scrub_state (id) VALUES (true);
