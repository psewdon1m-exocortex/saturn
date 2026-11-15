-- Assign membership in the existing atomic claim projection. The immutable
-- group is inserted and every member is fully validated in the same transaction.
-- No committed group has an unassigned member; callers cannot add new members.
INSERT INTO sync_extension_function_backup VALUES
 (87,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure)),
 (87,'guard_catalog_upload_group_member()',pg_get_functiondef('guard_catalog_upload_group_member()'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=replace(pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:='DECLARE final_transfer jsonb;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group projection declaration mismatch'; END IF;
 definition:=replace(definition,marker,'DECLARE claim_group uuid; final_transfer jsonb;');
 marker:=$body$ IF command='progress-verify-claim' THEN$body$;
 replacement:=$body$ IF command_payload ? 'publicationGroup' THEN
   IF command NOT IN ('verify-claim','progress-verify-claim') OR jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
     OR octet_length(command_payload::text)>2048 OR jsonb_typeof(command_payload->'publicationGroup') IS DISTINCT FROM 'string'
     OR command_payload->>'publicationGroup' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'invalid_input'; END IF;
   claim_group:=(command_payload->>'publicationGroup')::uuid;command_payload:=command_payload-'publicationGroup';
 END IF;
 IF command='progress-verify-claim' THEN$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group projection entry mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$   UPDATE public.operation_journal SET upload_publication_group=group_id WHERE id=ANY(group_members);$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group projection old update mismatch'; END IF;
 definition:=replace(definition,marker,'');
 marker:=$body$'sizeBytes',group_item->'input'->'intent'->>'sizeBytes','sha256',group_item->'input'->'intent'->>'sha256')||$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group projection recursive context mismatch'; END IF;
 definition:=replace(definition,marker,$body$'sizeBytes',group_item->'input'->'intent'->>'sizeBytes','sha256',group_item->'input'->'intent'->>'sha256','publicationGroup',group_id)||$body$);
 marker:=$body$   SELECT * INTO u FROM public.upload_sessions WHERE id=j.id FOR UPDATE;$body$;
 replacement:=$body$   IF claim_group IS NOT NULL THEN
     IF j.upload_publication_group IS NOT NULL OR j.upload_effect_state NOT IN ('transport','verified') OR j.sync_result IS NOT NULL
       OR NOT EXISTS(SELECT 1 FROM public.catalog_upload_publication_groups cg WHERE cg.id=claim_group AND cg.root_id=g.root_id AND j.id=ANY(cg.members))
       THEN RAISE EXCEPTION 'reconciliation_required'; END IF;
     -- Only the local projection changes before all original claim checks pass.
     j.upload_publication_group:=claim_group;
   END IF;
   SELECT * INTO u FROM public.upload_sessions WHERE id=j.id FOR UPDATE;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group projection membership mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$upload_last_transfer=coalesce(final_transfer,upload_last_transfer),updated_at=now() WHERE id=j.id;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group projection final update mismatch'; END IF;
 definition:=replace(definition,marker,$body$upload_last_transfer=coalesce(final_transfer,upload_last_transfer),upload_publication_group=j.upload_publication_group,updated_at=now() WHERE id=j.id;$body$);
 EXECUTE definition;

 definition:=pg_get_functiondef('guard_catalog_upload_group_member()'::regprocedure);
 marker:=$body$NEW.upload_effect_state NOT IN ('transport','verified')$body$;
 replacement:=$body$(NEW.upload_effect_state NOT IN ('transport','verified') AND NOT (
     TG_OP='UPDATE' AND OLD.upload_effect_state IN ('transport','verified') AND OLD.upload_claim_token IS NULL
     AND NEW.upload_effect_state='physical_pending' AND NEW.upload_claim_token IS NOT NULL))$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'group projection trigger mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
