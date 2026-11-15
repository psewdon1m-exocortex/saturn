-- Only an explicitly created chunk-once intent may reuse its backend task id.
-- Legacy pending transfers remain unresolved; absence of a task is not proof.
INSERT INTO sync_extension_function_backup VALUES(82,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));
ALTER TABLE operation_journal ADD COLUMN upload_transfer_backend_task uuid;
ALTER TABLE operation_journal ADD CONSTRAINT operation_upload_transfer_backend_task CHECK(
 upload_transfer_backend_task IS NULL OR (upload_transfer IS NOT NULL AND upload_effect_state='transport'
   AND upload_transfer_backend_task::text=upload_transfer->>'token'));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=replace(pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:=$body$'chunk','progress'$body$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>3 THEN RAISE EXCEPTION 'replayable chunk whitelist mismatch'; END IF;
 definition:=replace(definition,marker,$body$'chunk','chunk-once','progress'$body$);
 marker:=$body$ELSIF command='chunk' THEN
     IF j.upload_effect_state<>'transport' OR j.upload_transfer IS NOT NULL$body$;
 replacement:=$body$ELSIF command='chunk-once' AND j.upload_transfer IS NOT NULL THEN
     IF j.upload_effect_state<>'transport' OR j.upload_transfer_backend_task IS NULL
       OR j.upload_transfer_backend_task::text IS DISTINCT FROM j.upload_transfer->>'token'
       OR j.upload_transfer->>'offset' IS DISTINCT FROM command_payload->>'offset'
       OR j.upload_transfer->>'length' IS DISTINCT FROM command_payload->>'length'
       OR (command_payload->>'length')::bigint>4194304 THEN RAISE EXCEPTION 'transfer_unresolved' USING ERRCODE='55000'; END IF;
     -- Reuse only the original durable reservation, never the caller's new UUID.
   ELSIF command IN ('chunk','chunk-once') THEN
     IF command='chunk-once' AND (command_payload->>'length')::bigint>4194304 THEN RAISE EXCEPTION 'invalid_input'; END IF;
     IF j.upload_effect_state<>'transport' OR j.upload_transfer IS NOT NULL$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'replayable chunk body mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$UPDATE public.operation_journal SET upload_transfer=command_payload,updated_at=now() WHERE id=j.id;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'replayable chunk reservation mismatch'; END IF;
 definition:=replace(definition,marker,$body$UPDATE public.operation_journal SET upload_transfer=command_payload,
       upload_transfer_backend_task=CASE WHEN command='chunk-once' THEN (command_payload->>'token')::uuid ELSE NULL END,updated_at=now() WHERE id=j.id;$body$);
 marker:=$body$SET upload_transfer=NULL,upload_last_transfer=command_payload$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'replayable chunk progress mismatch'; END IF;
 definition:=replace(definition,marker,$body$SET upload_transfer=NULL,upload_transfer_backend_task=NULL,upload_last_transfer=command_payload$body$);
 marker:=$body$ RETURN jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object('uploadId',j.id,'operationId',j.id,'rootId',g.root_id,'intentHash',h,'expectedSizeBytes',u.expected_size::text,'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'result',j.sync_result,'replayed',false);$body$;
 replacement:=$body$ resultj:=jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object('uploadId',j.id,'operationId',j.id,'rootId',g.root_id,'intentHash',h,'expectedSizeBytes',u.expected_size::text,'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'result',j.sync_result,'replayed',false);
 IF command='chunk-once' THEN RETURN jsonb_build_object('current',resultj,'transfer',j.upload_transfer); END IF;
 RETURN resultj;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'replayable chunk projection mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
CREATE FUNCTION catalog_upload_replayable_chunk_v1() RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
REVOKE ALL ON FUNCTION catalog_upload_replayable_chunk_v1() FROM PUBLIC;
