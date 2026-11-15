DO $$ DECLARE definition text; BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') OR EXISTS(SELECT 1 FROM sync_backend_read_slots) THEN RAISE EXCEPTION 'backend must be stopped before metadata admission rollback'; END IF;
 SELECT b.definition INTO STRICT definition FROM sync_extension_function_backup b WHERE revision=119 AND identity='sync_backend_command(text,jsonb,jsonb)';
 EXECUTE definition;
END $$;
ALTER TABLE sync_backend_read_slots DROP COLUMN kind;
DELETE FROM sync_extension_function_backup WHERE revision=119;
