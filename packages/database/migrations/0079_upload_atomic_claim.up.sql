-- verify-claim has one transaction/one externally visible checkpoint. Project
-- its final state once, retaining all verification, namespace and fencing gates.
INSERT INTO sync_extension_function_backup VALUES
 (79,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure)),
 (79,'guard_catalog_upload_execution()',pg_get_functiondef('guard_catalog_upload_execution()'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=pg_get_functiondef('guard_catalog_upload_execution()'::regprocedure);
 marker:=$body$OLD.upload_effect_state='verified' AND NEW.upload_effect_state='physical_pending'$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'atomic claim token guard mismatch'; END IF;
 definition:=replace(definition,marker,$body$OLD.upload_effect_state IN ('transport','verified') AND NEW.upload_effect_state='physical_pending'$body$);
 marker:=$body$OLD.upload_effect_state='transport' AND NEW.upload_effect_state IN ('verified','not_published')$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'atomic claim transition guard mismatch'; END IF;
 definition:=replace(definition,marker,$body$OLD.upload_effect_state='transport' AND NEW.upload_effect_state IN ('verified','physical_pending','not_published')$body$);
 EXECUTE definition;
 definition:=pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure);
 marker:=$body$UPDATE public.operation_journal SET upload_effect_state='verified',updated_at=now() WHERE id=j.id;
     UPDATE public.upload_sessions SET status='verifying',actual_sha256=i->>'sha256',updated_at=now() WHERE id=j.id;
     IF command='verify-claim' THEN
       IF c.published_seq>9223372036854775807-(CASE WHEN u.expected_size=coalesce(child.size_bytes,0) THEN 1 ELSE cardinality(inroot)+1 END) THEN RAISE EXCEPTION 'counter_exhausted' USING ERRCODE='55000'; END IF;
       UPDATE public.operation_journal SET upload_effect_state='physical_pending',upload_claim_token=(command_payload->>'claimToken')::uuid,state='committing',updated_at=now() WHERE id=j.id;
       UPDATE public.upload_sessions SET status='committing',updated_at=now() WHERE id=j.id;
     END IF;$body$;
 replacement:=$body$IF command='verify-claim' THEN
       IF c.published_seq>9223372036854775807-(CASE WHEN u.expected_size=coalesce(child.size_bytes,0) THEN 1 ELSE cardinality(inroot)+1 END) THEN RAISE EXCEPTION 'counter_exhausted' USING ERRCODE='55000'; END IF;
       UPDATE public.operation_journal SET upload_effect_state='physical_pending',upload_claim_token=(command_payload->>'claimToken')::uuid,state='committing',updated_at=now() WHERE id=j.id;
       UPDATE public.upload_sessions SET status='committing',actual_sha256=i->>'sha256',updated_at=now() WHERE id=j.id;
     ELSE
       UPDATE public.operation_journal SET upload_effect_state='verified',updated_at=now() WHERE id=j.id;
       UPDATE public.upload_sessions SET status='verifying',actual_sha256=i->>'sha256',updated_at=now() WHERE id=j.id;
     END IF;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'atomic claim projection mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
