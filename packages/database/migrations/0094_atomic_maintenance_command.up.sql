-- Fixed SQL-only entry points take transaction-scoped maintenance admission on
-- the command connection. No filesystem action or application callback runs in
-- this transaction. Existing outer filesystem admission remains unchanged.
LOCK TABLE sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before atomic maintenance migration'; END IF;
END $$;
CREATE FUNCTION sync_maintenance_command(kind text,command text,identity jsonb,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE recovery_pending boolean;
BEGIN
 IF kind IS NULL OR kind NOT IN ('backend','catalog') THEN RAISE EXCEPTION 'invalid_input'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'atomic maintenance requires read committed'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1397967206);
 -- Separate VOLATILE-function statements acquire fresh READ COMMITTED
 -- snapshots after a waiting lock. Never use a pre-lock CTE snapshot here.
 SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='_saturn_restore_guard') INTO recovery_pending;
 IF recovery_pending THEN
   RAISE EXCEPTION 'Interrupted recovery: original database is preserved; operator rollback is required';
 END IF;
 -- Invoker rights: the caller must still be allowed to execute the original
 -- qualified SECURITY DEFINER entry point. This wrapper grants no write right.
 IF kind='backend' THEN RETURN public.sync_backend_command(command,identity,payload); END IF;
 RETURN public.catalog_upload_command(command,'{}'::jsonb,identity,payload);
END $$;
