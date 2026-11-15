-- Releasing a completed read only removes that client's existing slot. It does
-- not allocate capacity, grant ownership, or need the physical-writer row lock.
INSERT INTO sync_extension_function_backup VALUES(80,'sync_backend_command(text,jsonb,jsonb)',pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure);
 marker:=$body$idle_claim:=command='claim' AND NOT EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=identity->>'backendIdentity' AND state='QUEUED');$body$;
 replacement:=$body$idle_claim:=command='claim' AND (
   NOT EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=identity->>'backendIdentity' AND state='QUEUED')
   OR EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=identity->>'backendIdentity' AND state='UNKNOWN')
   OR (SELECT count(*) FROM public.sync_backend_tasks WHERE backend_identity=identity->>'backendIdentity' AND state='RUNNING')>=4);
 -- A negative eligibility snapshot may defer a claim; it never grants one.
 -- Every eligible claim still rechecks capacity/overlap under the owner lock.$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'backend claim observation mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$IF command IN ('status','inspect') OR idle_claim THEN$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'backend release observation mismatch'; END IF;
 EXECUTE replace(definition,marker,$body$IF command IN ('status','inspect','read-release') OR idle_claim THEN$body$);
END $install$;
