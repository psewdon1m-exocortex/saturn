LOCK TABLE sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before atomic maintenance rollback'; END IF;
END $$;
DROP FUNCTION sync_maintenance_command(text,text,jsonb,jsonb);
