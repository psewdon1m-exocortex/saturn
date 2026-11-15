LOCK TABLE sync_backend_executor,sync_backend_tasks IN SHARE ROW EXCLUSIVE MODE;
DO $restore$
DECLARE definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 IF EXISTS(SELECT 1 FROM sync_backend_tasks WHERE payload->>'schema'='saturn.backend-write-verified-once.v1') THEN RAISE EXCEPTION 'verified write task history must be retained'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=98 AND identity='sync_backend_command(text,jsonb,jsonb)';
 IF definition IS NULL THEN RAISE EXCEPTION 'verified write predecessor missing'; END IF;
 EXECUTE definition;
END $restore$;
DELETE FROM sync_extension_function_backup WHERE revision=98 AND identity='sync_backend_command(text,jsonb,jsonb)';
