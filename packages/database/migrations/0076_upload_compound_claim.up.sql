-- Preserve both journal transitions and all publication preconditions, while
-- doing their common authority/topology/shape checks in one transaction.
INSERT INTO sync_extension_function_backup VALUES(76,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure);
 marker:=$body$('reserve','status','chunk','progress','verify','claim','commit','cancel','unknown')$body$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>2 THEN RAISE EXCEPTION 'compound command whitelist mismatch'; END IF;
 definition:=replace(definition,marker,$body$('reserve','status','chunk','progress','verify','claim','verify-claim','commit','cancel','unknown')$body$);
 marker:=$body$IF command IN ('reserve','claim','commit') THEN$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'compound namespace checks mismatch'; END IF;
 definition:=replace(definition,marker,$body$IF command IN ('reserve','claim','verify-claim','commit') THEN$body$);
 marker:=$body$ELSIF command='verify' THEN
     IF (SELECT count(*) FROM jsonb_object_keys(command_payload))<>4$body$;
 replacement:=$body$ELSIF command IN ('verify','verify-claim') THEN
     IF command='verify-claim' AND (jsonb_typeof(command_payload->'claimToken') IS DISTINCT FROM 'string' OR command_payload->>'claimToken' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
     IF (SELECT count(*) FROM jsonb_object_keys(command_payload))<>(CASE WHEN command='verify-claim' THEN 5 ELSE 4 END)$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'compound payload mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$ELSIF command='verify' THEN
     IF j.upload_effect_state$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'compound verification mismatch'; END IF;
 definition:=replace(definition,marker,$body$ELSIF command IN ('verify','verify-claim') THEN
     IF j.upload_effect_state$body$);
 marker:=$body$UPDATE public.upload_sessions SET status='verifying',actual_sha256=i->>'sha256',updated_at=now() WHERE id=j.id;$body$;
 replacement:=marker||$body$
     IF command='verify-claim' THEN
       IF c.published_seq>9223372036854775807-(CASE WHEN u.expected_size=coalesce(child.size_bytes,0) THEN 1 ELSE cardinality(inroot)+1 END) THEN RAISE EXCEPTION 'counter_exhausted' USING ERRCODE='55000'; END IF;
       UPDATE public.operation_journal SET upload_effect_state='physical_pending',upload_claim_token=(command_payload->>'claimToken')::uuid,state='committing',updated_at=now() WHERE id=j.id;
       UPDATE public.upload_sessions SET status='committing',updated_at=now() WHERE id=j.id;
     END IF;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'compound transition mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
-- Presence is discovered once by the opted-in batched coordinator. Older
-- qualified databases keep the existing two-command protocol.
CREATE FUNCTION catalog_upload_compound_v1() RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
REVOKE ALL ON FUNCTION catalog_upload_compound_v1() FROM PUBLIC;
