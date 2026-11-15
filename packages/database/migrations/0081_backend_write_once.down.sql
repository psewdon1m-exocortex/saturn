DO $restore$
DECLARE definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 IF EXISTS(SELECT 1 FROM sync_backend_tasks WHERE payload->>'schema'='saturn.backend-write-once.v1') THEN RAISE EXCEPTION 'write-once task history must be retained'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=81 AND identity='sync_backend_command(text,jsonb,jsonb)';
 IF definition IS NULL THEN RAISE EXCEPTION 'write-once predecessor missing'; END IF;
 EXECUTE definition;
END $restore$;
DELETE FROM sync_extension_function_backup WHERE revision=81 AND identity='sync_backend_command(text,jsonb,jsonb)';
