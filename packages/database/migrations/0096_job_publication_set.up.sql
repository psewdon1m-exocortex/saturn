-- Metadata publication may cover all sixteen originals of ONE already accepted
-- job. This changes no physical worker/read-slot limit. Renames remain serial
-- inside a single durable task; an ambiguous partial group stays UNKNOWN.
LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before job publication migration'; END IF;
END $$;
INSERT INTO sync_extension_function_backup SELECT 96,p.oid::regprocedure::text,pg_get_functiondef(p.oid) FROM pg_proc p
 WHERE p.oid IN ('catalog_upload_claim_set_v1(jsonb,jsonb)'::regprocedure,'catalog_upload_publish_set_v1(jsonb,jsonb)'::regprocedure,'sync_backend_command(text,jsonb,jsonb)'::regprocedure);
ALTER TABLE catalog_upload_publication_groups DROP CONSTRAINT catalog_upload_publication_groups_members_check;
ALTER TABLE catalog_upload_publication_groups ADD CONSTRAINT catalog_upload_publication_groups_members_check CHECK(cardinality(members) BETWEEN 1 AND 16);
CREATE FUNCTION guard_job_publication_set() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE job uuid;
BEGIN
 IF cardinality(NEW.members)<=4 THEN RETURN NEW; END IF;
 SELECT upload_execution_job INTO job FROM public.operation_journal WHERE id=NEW.members[1];
 IF job IS NULL OR (SELECT count(DISTINCT id) FROM unnest(NEW.members) id)<>cardinality(NEW.members)
   OR NOT EXISTS(SELECT 1 FROM public.sync_small_execution_jobs e WHERE e.id=job AND e.root_id=NEW.root_id AND e.members @> NEW.members)
   OR (SELECT count(*) FROM public.operation_journal j WHERE j.id=ANY(NEW.members) AND j.sync_root_id=NEW.root_id
     AND j.upload_execution_job=job AND j.upload_effect_state IN ('transport','verified') AND j.sync_result IS NULL)<>cardinality(NEW.members)
 THEN RAISE EXCEPTION 'publication group membership invalid'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_job_publication_set() FROM PUBLIC;
CREATE TRIGGER catalog_upload_job_set_guard BEFORE INSERT ON catalog_upload_publication_groups FOR EACH ROW EXECUTE FUNCTION guard_job_publication_set();
DO $install$
DECLARE signature text; definition text; marker text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['catalog_upload_claim_set_v1(jsonb,jsonb)','catalog_upload_publish_set_v1(jsonb,jsonb)'] LOOP
   definition:=pg_get_functiondef(signature::regprocedure);marker:='jsonb_array_length(items) NOT BETWEEN 1 AND 4';
   IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'job publication predecessor mismatch'; END IF;
   EXECUTE replace(definition,marker,'jsonb_array_length(items) NOT BETWEEN 1 AND 16');
 END LOOP;
 definition:=pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure);
 marker:=$m$jsonb_array_length(payload->'body'->'members') NOT BETWEEN 1 AND 4$m$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'job rename predecessor mismatch'; END IF;
 definition:=replace(definition,marker,$m$jsonb_array_length(payload->'body'->'members') NOT BETWEEN 1 AND 16$m$);
 marker:=$m$   IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'body'->'members') m WHERE$m$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'job rename guard predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,$m$   IF jsonb_array_length(payload->'body'->'members')>4
   AND NOT EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE id=(payload->>'id')::uuid) AND NOT EXISTS(
     SELECT 1 FROM public.catalog_upload_publication_groups cg
     WHERE cardinality(cg.members)=jsonb_array_length(payload->'body'->'members') AND cardinality(cg.members)>4
       AND EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.id=ANY(cg.members) AND j.upload_claim_token::text=payload->>'id')
       AND (SELECT count(*) FROM jsonb_array_elements(payload->'body'->'members') m JOIN public.operation_journal j ON j.id::text=m->>'operationId'
         WHERE j.id=ANY(cg.members) AND j.upload_publication_group=cg.id AND j.upload_effect_state='physical_pending' AND j.sync_result IS NULL
           AND j.upload_execution->>'backendIdentity'=identity->>'backendIdentity'
           AND j.upload_execution->>'tempPath'=m->>'source' AND j.upload_execution->>'targetPath'=m->>'destination')=cardinality(cg.members)
   ) THEN RAISE EXCEPTION 'publication group membership invalid'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'body'->'members') m WHERE$m$);
END $install$;
CREATE FUNCTION catalog_upload_job_publication_v1() RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
REVOKE ALL ON FUNCTION catalog_upload_job_publication_v1() FROM PUBLIC;
