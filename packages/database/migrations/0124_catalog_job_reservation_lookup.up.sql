-- The admission trigger checks whether a new member shares an already counted
-- execution-job reservation. Bound that lookup to the job instead of scanning
-- all historical publications while holding the backend ownership row.
-- No reservation, concurrency, timeout or authority limit changes.
SELECT pg_advisory_xact_lock(1397967206);
CREATE INDEX operation_catalog_job_reservation ON operation_journal(upload_execution_job)
 WHERE upload_execution_job IS NOT NULL;
