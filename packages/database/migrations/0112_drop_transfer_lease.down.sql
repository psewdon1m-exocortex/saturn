-- Stop the workers first. Never remove fencing from an in-flight transfer.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM drop_uploads WHERE state IN ('transferring', 'verifying')
             AND transfer_lease_token IS NOT NULL) THEN
    RAISE EXCEPTION 'Drop transfer leases must be drained before rollback';
  END IF;
END $$;
DROP INDEX drop_uploads_transfer_lease_idx;
ALTER TABLE drop_uploads DROP COLUMN transfer_lease_token, DROP COLUMN transfer_lease_until;
