-- Restore the exact qualified definition, including intervening migrations.
DO $$ DECLARE definition text; BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 IF EXISTS(SELECT 1 FROM sync_backend_tasks WHERE state IN ('QUEUED','RUNNING','UNKNOWN') AND payload ? 'payloadRef') THEN RAISE EXCEPTION 'retained payload references prevent rollback'; END IF;
 SELECT b.definition INTO STRICT definition FROM sync_extension_function_backup b WHERE revision=72 AND identity='sync_backend_command(text,jsonb,jsonb)';
 EXECUTE definition;
END $$;
DELETE FROM sync_extension_function_backup WHERE revision=72;
