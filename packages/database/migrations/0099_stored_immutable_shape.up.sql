-- Reuse the exact immutable shape already enforced by protected table guards.
-- These predicates prove syntax only, never authority, topology, epoch, current
-- phase or physical state. Every existing command's live checks stay in place.
LOCK TABLE sync_backend_executor,catalog_guard_roots,sync_small_batches,operation_journal IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before shape migration'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='operation_journal'::regclass AND conname='operation_catalog_upload_shape' AND contype='c' AND convalidated
   AND pg_get_constraintdef(oid)='CHECK ((catalog_upload_shape(operation_journal.*) IS TRUE))')
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='sync_small_batches'::regclass AND tgname='sync_small_batches_guard' AND tgenabled='O'
     AND tgfoid='sync_small_batch_guard()'::regprocedure)
   OR strpos(pg_get_functiondef('sync_small_batch_guard()'::regprocedure),'public.sync_small_batch_plan_valid(NEW.plan)')=0
 THEN RAISE EXCEPTION 'protected immutable shape prerequisite missing'; END IF;
END $$;
INSERT INTO sync_extension_function_backup SELECT 99,p.oid::regprocedure::text,pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.oid IN (
 'catalog_upload_accept_job_v1(jsonb,jsonb)'::regprocedure,'guard_small_execution_job()'::regprocedure,
 'sync_small_batch_command(text,jsonb,jsonb,jsonb)'::regprocedure,
 'catalog_upload_claim_set_v1(jsonb,jsonb)'::regprocedure,'catalog_upload_publish_set_v1(jsonb,jsonb)'::regprocedure);

CREATE FUNCTION sync_small_batch_known_shape(p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE root_text text:=p->'manifest'->>'root_id'; device_text text:=p->'inputs'->0->'intent'->>'deviceId';
BEGIN
 -- Check cast syntax before querying the complete primary binding. Equality
 -- includes every field and every member, not merely a client supplied hash.
 IF root_text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND device_text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
   IF EXISTS(SELECT 1 FROM public.sync_small_batches b WHERE b.root_id=root_text::uuid AND b.device_id=device_text::uuid
     AND b.batch_key=p->'manifest'->>'batch_id' AND b.plan=p) THEN RETURN true; END IF;
 END IF;
 RETURN public.sync_small_batch_plan_valid(p);
END $$;
CREATE FUNCTION catalog_upload_known_intent(original text,i jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF original ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
   IF EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.id=original::uuid AND j.upload_execution IS NOT NULL AND j.upload_intent=i)
   THEN RETURN true; END IF;
 END IF;
 RETURN public.catalog_upload_intent_valid(i);
END $$;
REVOKE ALL ON FUNCTION sync_small_batch_known_shape(jsonb),catalog_upload_known_intent(text,jsonb) FROM PUBLIC;
DO $install$
DECLARE row record; definition text; marker text; replacement text; owner_name text;
BEGIN
 FOR row IN SELECT identity FROM sync_extension_function_backup WHERE revision=99 LOOP
   definition:=pg_get_functiondef(row.identity::regprocedure);
   IF row.identity IN ('catalog_upload_claim_set_v1(jsonb,jsonb)','catalog_upload_publish_set_v1(jsonb,jsonb)') THEN
     marker:=$m$public.catalog_upload_intent_valid(a->'input'->'intent')$m$;
     replacement:=$m$public.catalog_upload_known_intent(a->>'originalUploadId',a->'input'->'intent')$m$;
   ELSIF row.identity='sync_small_batch_command(text,jsonb,jsonb,jsonb)' THEN
     marker:='public.sync_small_batch_plan_valid(payload)'; replacement:='public.sync_small_batch_known_shape(payload)';
   ELSE
     marker:='public.sync_small_batch_plan_valid(plan)'; replacement:='public.sync_small_batch_known_shape(plan)';
   END IF;
   IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'stored shape predecessor mismatch: %',row.identity; END IF;
   EXECUTE replace(definition,marker,replacement);
 END LOOP;
 FOR owner_name IN SELECT DISTINCT writer_owner FROM public.catalog_guard_roots LOOP
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.sync_small_batch_known_shape(jsonb),public.catalog_upload_known_intent(text,jsonb) TO %I',owner_name);
 END LOOP;
END $install$;
