-- Apply with API/worker processes stopped, as required by the release protocol.
-- Preserve original uploads, buffers, attempts, receipts and retry deadlines.
ALTER TABLE drop_uploads
  ADD COLUMN transfer_lease_token uuid,
  ADD COLUMN transfer_lease_until timestamptz;

-- Pre-upgrade interrupted jobs become eligible after one short lease. They are
-- never recaptured as new uploads; the existing Drop idempotency key is retained.
UPDATE drop_uploads SET transfer_lease_until = clock_timestamp() + interval '60 seconds'
WHERE state IN ('transferring', 'verifying');

CREATE INDEX drop_uploads_transfer_lease_idx ON drop_uploads (transfer_lease_until, created_at, id)
WHERE state IN ('transferring', 'verifying');
