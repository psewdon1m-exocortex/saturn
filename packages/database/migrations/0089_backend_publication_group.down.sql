LOCK TABLE sync_backend_executor,sync_backend_tasks IN SHARE ROW EXCLUSIVE MODE;
DO $restore$
DECLARE definition text; constraint_definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 IF EXISTS(SELECT 1 FROM sync_backend_tasks WHERE command='rename-group') THEN RAISE EXCEPTION 'publication group task history must be retained'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=89 AND identity='sync_backend_command(text,jsonb,jsonb)';
 SELECT b.definition INTO constraint_definition FROM sync_extension_function_backup b WHERE revision=89 AND identity='constraint:sync_backend_tasks_command_check';
 IF definition IS NULL OR constraint_definition IS NULL THEN RAISE EXCEPTION 'publication group predecessor missing'; END IF;
 EXECUTE definition;
 ALTER TABLE sync_backend_tasks DROP CONSTRAINT sync_backend_tasks_command_check;
 EXECUTE 'ALTER TABLE sync_backend_tasks ADD CONSTRAINT sync_backend_tasks_command_check '||constraint_definition;
END $restore$;
DELETE FROM sync_extension_function_backup WHERE revision=89;
