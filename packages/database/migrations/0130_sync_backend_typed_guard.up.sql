-- Read the text identity directly on the three backend tables.
-- Preserve the JSON path for every other trigger relation.
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.pg_advisory_xact_lock(1397967206);
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $migration$
DECLARE
  target regprocedure := 'public.sync_extension_write_guard()'::regprocedure;
  original text;
  previous_search_path text := pg_catalog.current_setting('search_path');
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  IF EXISTS (SELECT 1 FROM public.sync_backend_executor WHERE state <> 'STOPPED') THEN
    RAISE EXCEPTION 'backend must be stopped before typed backend guard migration';
  END IF;
  original := pg_get_functiondef(target);
  IF encode(sha256(convert_to(replace(original,E'\r\n',E'\n'),'UTF8')),'hex') <> 'ff30c1c5bad3fe0f122f2aab018d124c65b10d758fb13e2f9bf5b1358db505d4' THEN
    RAISE EXCEPTION 'unexpected backend guard definition before migration 130';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
      WHERE a.attrelid IN ('public.sync_backend_executor'::regclass,
        'public.sync_backend_tasks'::regclass,'public.sync_backend_read_slots'::regclass)
        AND a.attname = 'backend_identity' AND a.atttypid = 'text'::regtype AND NOT a.attisdropped
        AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = a.attrelid AND t.tgfoid = target
          AND t.tgtype = 31 AND t.tgenabled IN ('O','A'))) <> 3 THEN
    RAISE EXCEPTION 'unexpected backend guard trigger layout before migration 130';
  END IF;
  INSERT INTO public.sync_extension_function_backup (revision, identity, definition)
    VALUES (130, 'public.sync_extension_write_guard()', original);
  EXECUTE $guard$CREATE OR REPLACE FUNCTION public.sync_extension_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE rowj jsonb; backend text; root uuid; login name; owner_name name;
BEGIN
 IF current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
 END IF;
 IF TG_TABLE_NAME IN ('sync_root_policy','sync_migration_plans','sync_migration_progress','sync_backend_handoffs','sync_extension_function_backup') THEN
   RAISE EXCEPTION 'offline_operator_required' USING ERRCODE='42501';
 END IF;
 IF TG_TABLE_NAME IN ('sync_backend_executor','sync_backend_tasks','sync_backend_read_slots') THEN
   IF TG_RELID IN ('public.sync_backend_executor'::regclass,'public.sync_backend_tasks'::regclass,'public.sync_backend_read_slots'::regclass) THEN
     backend:=CASE WHEN TG_OP='DELETE' THEN OLD.backend_identity ELSE NEW.backend_identity END;
   ELSE
     rowj:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
     backend:=rowj->>'backend_identity';
   END IF;
   SELECT writer_login,writer_owner INTO login,owner_name FROM public.sync_backend_executor WHERE backend_identity=backend;
 ELSE
   rowj:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
   root:=(rowj->>'root_id')::uuid;
   SELECT writer_login,writer_owner INTO login,owner_name FROM public.catalog_guard_roots WHERE root_id=root;
 END IF;
 IF login IS NULL OR session_user<>login OR current_user<>owner_name THEN RAISE EXCEPTION 'catalog writer unqualified' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $function$
$guard$;
  IF encode(sha256(convert_to(replace(pg_get_functiondef(target),E'\r\n',E'\n'),'UTF8')),'hex') <> '1a76e894aa1e61efe74c2444001528872702187a5cf3a0152ddb10cd08e98695' THEN
    RAISE EXCEPTION 'unexpected revised backend guard definition in migration 130';
  END IF;
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END
$migration$;
