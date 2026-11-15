-- A group is a bounded set of already staged, independently verified originals.
-- Only its own pending members may coexist; another group/new work and UNKNOWN
-- retain the existing root barrier. Every member keeps its original receipt.
INSERT INTO sync_extension_function_backup VALUES(78,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));
CREATE TABLE catalog_upload_publication_groups(
 id uuid PRIMARY KEY,
 root_id uuid NOT NULL REFERENCES catalog_guard_roots(root_id),
 members uuid[] NOT NULL CHECK(cardinality(members) BETWEEN 1 AND 4),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER catalog_upload_group_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON catalog_upload_publication_groups FOR EACH ROW EXECUTE FUNCTION catalog_guard_rows();
CREATE FUNCTION guard_catalog_upload_publication_group() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'publication group is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER catalog_upload_group_immutable BEFORE UPDATE OR DELETE ON catalog_upload_publication_groups FOR EACH ROW EXECUTE FUNCTION guard_catalog_upload_publication_group();
ALTER TABLE operation_journal ADD COLUMN upload_publication_group uuid REFERENCES catalog_upload_publication_groups(id);
CREATE FUNCTION guard_catalog_upload_group_member() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.upload_publication_group IS NOT DISTINCT FROM OLD.upload_publication_group THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.upload_publication_group IS NOT NULL THEN RAISE EXCEPTION 'publication group is immutable' USING ERRCODE='55000'; END IF;
 IF NEW.upload_publication_group IS NULL THEN RETURN NEW; END IF;
 IF NEW.upload_execution IS NULL OR NEW.upload_effect_state NOT IN ('transport','verified') OR NEW.sync_result IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM public.catalog_upload_publication_groups g WHERE g.id=NEW.upload_publication_group AND g.root_id=NEW.sync_root_id AND NEW.id=ANY(g.members))
 THEN RAISE EXCEPTION 'publication group membership invalid' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER operation_catalog_upload_group_guard AFTER INSERT OR UPDATE ON operation_journal FOR EACH ROW EXECUTE FUNCTION guard_catalog_upload_group_member();
REVOKE ALL ON FUNCTION guard_catalog_upload_publication_group(),guard_catalog_upload_group_member() FROM PUBLIC;
DO $install$
DECLARE definition text; marker text; replacement text; owner_name text;
BEGIN
 definition:=pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure);
 marker:='DECLARE batch_item jsonb;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'publication group declaration mismatch'; END IF;
 definition:=replace(definition,marker,'DECLARE group_item jsonb; group_values jsonb; group_root uuid; group_id uuid; group_members uuid[]; batch_item jsonb;');
 marker:=$body$ IF command='batch' THEN$body$;
 replacement:=$body$
 IF command='verify-claim-group' THEN
   IF input IS DISTINCT FROM '{}'::jsonb OR jsonb_typeof(command_payload) IS DISTINCT FROM 'array'
     OR jsonb_array_length(command_payload) NOT BETWEEN 1 AND 4 OR octet_length(command_payload::text)>524288 THEN RAISE EXCEPTION 'invalid_input'; END IF;
   FOR group_item IN SELECT value FROM jsonb_array_elements(command_payload) LOOP
     IF jsonb_typeof(group_item) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(group_item))<>4
       OR NOT group_item ?& ARRAY['input','originalUploadId','claimToken','mimeType']
       OR jsonb_typeof(group_item->'input') IS DISTINCT FROM 'object'
       OR jsonb_typeof(group_item->'originalUploadId') IS DISTINCT FROM 'string' OR group_item->>'originalUploadId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
       OR jsonb_typeof(group_item->'claimToken') IS DISTINCT FROM 'string' OR group_item->>'claimToken' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
       OR jsonb_typeof(group_item->'mimeType') IS DISTINCT FROM 'string' OR length(group_item->>'mimeType') NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'invalid_input'; END IF;
   END LOOP;
   group_root:=(command_payload->0->'input'->'intent'->>'rootId')::uuid;
   SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=group_root;
   IF NOT FOUND OR current_user<>g.writer_owner OR session_user<>g.writer_login THEN RAISE EXCEPTION 'binding_invalid'; END IF;
   PERFORM root_id FROM public.sync_root_clock WHERE root_id=group_root FOR UPDATE;
   group_members:=ARRAY(SELECT (value->>'originalUploadId')::uuid FROM jsonb_array_elements(command_payload));
   IF (SELECT count(DISTINCT member) FROM unnest(group_members) member)<>cardinality(group_members) THEN RAISE EXCEPTION 'invalid_input'; END IF;
   PERFORM id FROM public.operation_journal WHERE id=ANY(group_members) ORDER BY id FOR UPDATE;
   IF (SELECT count(*) FROM public.operation_journal WHERE id=ANY(group_members))<>cardinality(group_members)
     OR EXISTS(SELECT 1 FROM public.operation_journal WHERE id=ANY(group_members) AND (sync_root_id IS DISTINCT FROM group_root OR upload_execution IS NULL OR upload_publication_group IS NOT NULL OR upload_effect_state NOT IN ('transport','verified') OR upload_transfer IS NOT NULL OR sync_result IS NOT NULL))
     THEN RAISE EXCEPTION 'reconciliation_required'; END IF;
   IF EXISTS(SELECT 1 FROM public.operation_journal a JOIN public.operation_journal b ON a.id<b.id WHERE a.id=ANY(group_members) AND b.id=ANY(group_members)
     AND (lower(a.upload_execution->>'targetPath')=lower(b.upload_execution->>'targetPath') OR starts_with(lower(a.upload_execution->>'targetPath'),lower(b.upload_execution->>'targetPath')||'/') OR starts_with(lower(b.upload_execution->>'targetPath'),lower(a.upload_execution->>'targetPath')||'/')))
     THEN RAISE EXCEPTION 'precondition_failed'; END IF;
   IF (SELECT published_seq FROM public.sync_root_clock WHERE root_id=group_root)>9223372036854775807-(
     SELECT sum(CASE WHEN (upload_intent->>'sizeBytes')::bigint=coalesce((upload_execution->'before'->>'size_bytes')::bigint,0) THEN 1 ELSE jsonb_array_length(upload_execution->'pathTopology')+1 END)
     FROM public.operation_journal WHERE id=ANY(group_members)) THEN RAISE EXCEPTION 'counter_exhausted'; END IF;
   group_id:=gen_random_uuid();
   INSERT INTO public.catalog_upload_publication_groups(id,root_id,members,request_hash) VALUES(group_id,group_root,group_members,encode(sha256(convert_to(command_payload::text,'UTF8')),'hex'));
   UPDATE public.operation_journal SET upload_publication_group=group_id WHERE id=ANY(group_members);
   group_values:='[]'::jsonb;
   FOR group_item IN SELECT value FROM jsonb_array_elements(command_payload) LOOP
     group_values:=group_values||jsonb_build_array(public.catalog_upload_command('verify-claim',group_item->'input',credential,jsonb_build_object(
       'originalUploadId',group_item->>'originalUploadId','claimToken',group_item->>'claimToken','mimeType',group_item->>'mimeType',
       'sizeBytes',group_item->'input'->'intent'->>'sizeBytes','sha256',group_item->'input'->'intent'->>'sha256')));
   END LOOP;
   RETURN group_values;
 END IF;
 IF command='batch' THEN$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'publication group entry mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$AND NOT coalesce(x.upload_execution IS NOT NULL AND x.upload_effect_state IN ('transport','verified'),false))$body$;
 replacement:=$body$AND NOT coalesce(x.upload_execution IS NOT NULL AND (x.upload_effect_state IN ('transport','verified') OR
     command IN ('verify-claim','commit') AND j.upload_publication_group IS NOT NULL AND x.upload_publication_group=j.upload_publication_group AND x.upload_effect_state='physical_pending'),false))$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'publication group barrier mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
 FOR owner_name IN SELECT DISTINCT writer_owner FROM public.catalog_guard_roots LOOP
   EXECUTE format('GRANT SELECT,INSERT ON public.catalog_upload_publication_groups TO %I',owner_name);
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.guard_catalog_upload_publication_group(),public.guard_catalog_upload_group_member() TO %I',owner_name);
 END LOOP;
END $install$;
CREATE FUNCTION catalog_upload_publication_group_v1() RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
REVOKE ALL ON FUNCTION catalog_upload_publication_group_v1() FROM PUBLIC;
