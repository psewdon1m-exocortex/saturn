-- A new explicit command admits exact originals and grants transfer permits
-- in one transaction. The existing prepare/start/status protocol is unchanged.
LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before single request migration'; END IF;
END $$;
INSERT INTO sync_extension_function_backup VALUES(101,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text; owner_name text;
BEGIN
 definition:=pg_get_functiondef('catalog_upload_accept_job_v1(jsonb,jsonb)'::regprocedure);
 definition:=replace(definition,'FUNCTION public.catalog_upload_accept_job_v1(', 'FUNCTION public.catalog_upload_execute_job_v1(');
 marker:=$m$execute_job:=payload ? 'execute';$m$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'single request execution predecessor mismatch'; END IF;
 definition:=replace(definition,marker,'execute_job:=true;');
 marker:=$m$IF (execute_job OR payload ? 'readOnly') AND NOT replayed THEN$m$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'single request admission predecessor mismatch'; END IF;
 definition:=replace(definition,marker,$m$IF payload ? 'readOnly' AND NOT replayed THEN$m$);
 EXECUTE definition;
 REVOKE ALL ON FUNCTION public.catalog_upload_execute_job_v1(jsonb,jsonb) FROM PUBLIC;
 definition:=pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure);
 marker:=$m$IF command IN ('accept-job','start-job','status-job') THEN$m$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'single request command predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,$m$IF command='execute-job' THEN
   IF input IS DISTINCT FROM '{}'::jsonb OR jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(command_payload))<>1 OR NOT command_payload ? 'planBytes' THEN RAISE EXCEPTION 'invalid_input'; END IF;
   RETURN public.catalog_upload_execute_job_v1(credential,command_payload);
 END IF;
 IF command IN ('accept-job','start-job','status-job') THEN$m$);
 FOR owner_name IN SELECT DISTINCT writer_owner FROM public.catalog_guard_roots LOOP
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.catalog_upload_execute_job_v1(jsonb,jsonb) TO %I',owner_name);
 END LOOP;
END $install$;
CREATE FUNCTION catalog_upload_job_single_request_v1() RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS 'SELECT true';
