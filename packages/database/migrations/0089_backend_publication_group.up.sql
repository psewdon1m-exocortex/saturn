-- One immutable task for an already claimed, disjoint publication group.
-- The executor runs its renames sequentially in ONE physical worker slot.
-- Partial effects remain UNKNOWN; no timeout or replay permits repeating them.
LOCK TABLE sync_backend_executor,sync_backend_tasks IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before group migration'; END IF;
END $$;
INSERT INTO sync_extension_function_backup VALUES(89,'sync_backend_command(text,jsonb,jsonb)',pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure));
INSERT INTO sync_extension_function_backup
 SELECT 89,'constraint:sync_backend_tasks_command_check',pg_get_constraintdef(oid)
 FROM pg_constraint WHERE conrelid='sync_backend_tasks'::regclass AND conname='sync_backend_tasks_command_check' AND convalidated;
ALTER TABLE sync_backend_tasks DROP CONSTRAINT sync_backend_tasks_command_check;
ALTER TABLE sync_backend_tasks ADD CONSTRAINT sync_backend_tasks_command_check CHECK(command IN ('write','truncate','mkdir','rename','copy','delete','rename-group'));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=replace(pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:=$body$'writeOnce',true);$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group capability predecessor mismatch'; END IF;
 definition:=replace(definition,marker,$body$'writeOnce',true,'renameGroup',true);$body$);
 marker:=$body$IF command IN ('submit','submit-once') THEN$body$;
 replacement:=$body$
 IF command='submit' AND payload->>'command'='rename-group' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(payload))<>4 OR NOT payload ?& ARRAY['id','command','body','reservedBytes']
     OR jsonb_typeof(payload->'id') IS DISTINCT FROM 'string' OR payload->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
     OR payload->'reservedBytes' IS DISTINCT FROM '"0"'::jsonb
     OR jsonb_typeof(payload->'body') IS DISTINCT FROM 'object'
     OR octet_length((payload->'body')::text)>524288
     OR payload->'body'->>'schema' IS DISTINCT FROM 'saturn.backend-rename-group.v1'
     OR jsonb_typeof(payload->'body'->'members') IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'invalid_input'; END IF;
   IF (SELECT count(*) FROM jsonb_object_keys(payload->'body'))<>2
     OR jsonb_array_length(payload->'body'->'members') NOT BETWEEN 1 AND 4
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'body'->'members') m WHERE jsonb_typeof(m) IS DISTINCT FROM 'object')
   THEN RAISE EXCEPTION 'invalid_input'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'body'->'members') m WHERE
     (SELECT count(*) FROM jsonb_object_keys(m))<>3 OR NOT m ?& ARRAY['operationId','source','destination']
     OR jsonb_typeof(m->'operationId') IS DISTINCT FROM 'string' OR m->>'operationId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
     OR jsonb_typeof(m->'source') IS DISTINCT FROM 'string' OR octet_length(m->>'source') NOT BETWEEN 1 AND 32768
     OR jsonb_typeof(m->'destination') IS DISTINCT FROM 'string' OR octet_length(m->>'destination') NOT BETWEEN 1 AND 32768)
     OR (SELECT count(DISTINCT m->>'operationId') FROM jsonb_array_elements(payload->'body'->'members') m)<>jsonb_array_length(payload->'body'->'members')
   THEN RAISE EXCEPTION 'invalid_input'; END IF;
   IF EXISTS(
     WITH paths AS(SELECT ord*2+k AS n,lower(p) AS p FROM jsonb_array_elements(payload->'body'->'members') WITH ORDINALITY a(m,ord)
       CROSS JOIN LATERAL (VALUES(0,m->>'source'),(1,m->>'destination')) q(k,p))
     SELECT 1 FROM paths a JOIN paths z ON a.n<z.n WHERE a.p=z.p OR starts_with(a.p,z.p||'/') OR starts_with(z.p,a.p||'/')
   ) THEN RAISE EXCEPTION 'invalid_input'; END IF;
 END IF;
 IF command IN ('submit','submit-once') THEN$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group submit predecessor mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$unnest(ARRAY[q.payload->>'path',q.payload->>'source',q.payload->>'destination'])$body$;
 replacement:=$body$unnest(CASE WHEN q.command='rename-group' THEN ARRAY(SELECT p FROM jsonb_array_elements(q.payload->'members') m CROSS JOIN LATERAL (VALUES(m->>'source'),(m->>'destination')) paths(p)) ELSE ARRAY[q.payload->>'path',q.payload->>'source',q.payload->>'destination'] END)$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group candidate paths predecessor mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$unnest(ARRAY[prior.payload->>'path',prior.payload->>'source',prior.payload->>'destination'])$body$;
 replacement:=$body$unnest(CASE WHEN prior.command='rename-group' THEN ARRAY(SELECT p FROM jsonb_array_elements(prior.payload->'members') m CROSS JOIN LATERAL (VALUES(m->>'source'),(m->>'destination')) paths(p)) ELSE ARRAY[prior.payload->>'path',prior.payload->>'source',prior.payload->>'destination'] END)$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group prior paths predecessor mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$IF t.state='RUNNING' THEN
     UPDATE public.sync_backend_executor SET completed_effects=completed_effects+CASE WHEN command='complete' THEN 1 ELSE 0 END,$body$;
 replacement:=$body$IF command='complete' AND t.command='rename-group' AND payload->'result' IS DISTINCT FROM jsonb_build_object(
     'schema','saturn.backend-rename-group-result.v1','operationIds',(SELECT jsonb_agg(m->'operationId' ORDER BY ord) FROM jsonb_array_elements(t.payload->'members') WITH ORDINALITY a(m,ord)))
   THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
   IF t.state='RUNNING' THEN
     UPDATE public.sync_backend_executor SET completed_effects=completed_effects+CASE WHEN command='complete' THEN CASE WHEN t.command='rename-group' THEN jsonb_array_length(t.payload->'members') ELSE 1 END ELSE 0 END,$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group completion predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
