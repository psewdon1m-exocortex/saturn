-- Observations cannot grant ownership or begin effects. Do not let them queue
-- behind mutation admission. Empty polls also do not renew an ownership lease:
-- ownership still changes only after the existing durable STOPPED receipt.
INSERT INTO sync_extension_function_backup VALUES(77,'sync_backend_command(text,jsonb,jsonb)',pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure);
 marker:='DECLARE b public.sync_backend_executor%ROWTYPE;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'backend observation declaration mismatch'; END IF;
 definition:=replace(definition,marker,'DECLARE idle_claim boolean; b public.sync_backend_executor%ROWTYPE;');
 marker:=$body$SELECT * INTO b FROM public.sync_backend_executor WHERE backend_identity=identity->>'backendIdentity' FOR UPDATE;$body$;
 replacement:=$body$idle_claim:=command='claim' AND NOT EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=identity->>'backendIdentity' AND state='QUEUED');
 IF command IN ('status','inspect') OR idle_claim THEN
   SELECT * INTO b FROM public.sync_backend_executor WHERE backend_identity=identity->>'backendIdentity';
 ELSE
   SELECT * INTO b FROM public.sync_backend_executor WHERE backend_identity=identity->>'backendIdentity' FOR UPDATE;
 END IF;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'backend observation lock mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$IF command='read-close' THEN$body$;
 replacement:=$body$IF idle_claim THEN
   IF b.owner_id::text IS DISTINCT FROM identity->>'ownerId' OR b.fencing_token::text IS DISTINCT FROM identity->>'fencingToken' OR b.state NOT IN ('RUNNING','DRAINING') THEN RAISE EXCEPTION 'backend_draining'; END IF;
   RETURN NULL;
 END IF;
 IF command='read-close' THEN$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'backend observation authority mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$RETURN jsonb_build_object('id',t.id);$body$;
 replacement:=$body$SELECT * INTO t FROM public.sync_backend_tasks WHERE id=t.id;
   RETURN jsonb_build_object('id',t.id,'state',t.state,'result',t.result,'errorCode',t.error_code);$body$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'backend terminal receipt mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
