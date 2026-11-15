DO $$ DECLARE definition text; BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') OR EXISTS(SELECT 1 FROM sync_backend_read_slots)
 THEN RAISE EXCEPTION 'backend must be stopped before owner readiness rollback'; END IF;
 SELECT b.definition INTO STRICT definition FROM sync_extension_function_backup b WHERE revision=120 AND identity='sync_backend_command(text,jsonb,jsonb)';
 EXECUTE definition;
END $$;
ALTER TABLE sync_backend_executor DROP COLUMN liveness_owner_id, DROP COLUMN liveness_fencing_token, DROP COLUMN liveness_at;
DELETE FROM sync_extension_function_backup WHERE revision=120;
