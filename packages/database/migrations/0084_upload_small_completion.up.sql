-- A verified final small chunk can atomically acknowledge progress and acquire
-- the final publication slot. Its original transfer/task identity is retained.
INSERT INTO sync_extension_function_backup VALUES(84,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=replace(pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:='DECLARE small_reserve boolean:=false;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small completion declaration mismatch'; END IF;
 definition:=replace(definition,marker,'DECLARE final_transfer jsonb; small_reserve boolean:=false;');
 marker:=$body$ IF command='reserve-small' THEN$body$;
 replacement:=$body$ IF command='progress-verify-claim' THEN
   IF jsonb_typeof(command_payload) IS DISTINCT FROM 'object' OR octet_length(command_payload::text)>2048
     OR jsonb_typeof(command_payload->'transfer') IS DISTINCT FROM 'object'
     OR octet_length((command_payload->'transfer')::text)>512 THEN RAISE EXCEPTION 'invalid_input'; END IF;
   final_transfer:=command_payload->'transfer';command_payload:=command_payload-'transfer';command:='verify-claim';
 END IF;
 IF command='reserve-small' THEN$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small completion entry mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$batch_item->>'command' NOT IN ('reserve-small','reserve'$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small completion batch mismatch'; END IF;
 definition:=replace(definition,marker,$body$batch_item->>'command' NOT IN ('progress-verify-claim','reserve-small','reserve'$body$);
 marker:=$body$ELSIF command IN ('verify','verify-claim') THEN
     IF j.upload_effect_state$body$;
 replacement:=$body$ELSIF command IN ('verify','verify-claim') THEN
     IF final_transfer IS NOT NULL THEN
       IF j.upload_effect_state<>'transport' OR j.upload_transfer_backend_task IS NULL
         OR j.upload_transfer IS DISTINCT FROM final_transfer
         OR j.upload_transfer_backend_task::text IS DISTINCT FROM final_transfer->>'token'
         OR final_transfer->>'offset' IS DISTINCT FROM u.received_size::text
         OR u.expected_size NOT BETWEEN 1 AND 262144
         OR u.received_size+(final_transfer->>'length')::bigint<>u.expected_size THEN RAISE EXCEPTION 'transfer_unresolved'; END IF;
       -- Only local variables change here; failed verification rolls back without
       -- clearing the durable transfer. The final two UPDATEs project all fields.
       u.received_size:=u.expected_size;j.upload_transfer:=NULL;
     END IF;
     IF j.upload_effect_state$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small completion verification mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$UPDATE public.operation_journal SET upload_effect_state='physical_pending',upload_claim_token=(command_payload->>'claimToken')::uuid,state='committing',updated_at=now() WHERE id=j.id;
       UPDATE public.upload_sessions SET status='committing',actual_sha256=i->>'sha256',updated_at=now() WHERE id=j.id;$body$;
 replacement:=$body$UPDATE public.operation_journal SET upload_effect_state='physical_pending',upload_claim_token=(command_payload->>'claimToken')::uuid,state='committing',
         upload_transfer=CASE WHEN final_transfer IS NOT NULL THEN NULL ELSE upload_transfer END,
         upload_transfer_backend_task=CASE WHEN final_transfer IS NOT NULL THEN NULL ELSE upload_transfer_backend_task END,
         upload_last_transfer=coalesce(final_transfer,upload_last_transfer),updated_at=now() WHERE id=j.id;
       UPDATE public.upload_sessions SET status='committing',actual_sha256=i->>'sha256',received_size=u.received_size,updated_at=now() WHERE id=j.id;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small completion projection mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 -- Mixed groups may contain ordinary completed transfers and exact marked final
 -- transfers. Every member still executes the full individual claim checks.
 marker:=$body$(SELECT count(*) FROM jsonb_object_keys(group_item))<>4$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small completion group shape mismatch'; END IF;
 definition:=replace(definition,marker,$body$(SELECT count(*) FROM jsonb_object_keys(group_item))<>(4+CASE WHEN group_item ? 'transfer' THEN 1 ELSE 0 END)$body$);
 marker:=$body$OR upload_transfer IS NOT NULL OR sync_result IS NOT NULL))$body$;
 replacement:=$body$OR upload_transfer IS NOT NULL AND NOT EXISTS(
       SELECT 1 FROM jsonb_array_elements(command_payload) entry WHERE entry->>'originalUploadId'=operation_journal.id::text
         AND entry->'transfer'=operation_journal.upload_transfer AND operation_journal.upload_transfer_backend_task IS NOT NULL)
       OR sync_result IS NOT NULL))$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small completion group pending mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$public.catalog_upload_command('verify-claim',group_item->'input',credential,jsonb_build_object(
       'originalUploadId',group_item->>'originalUploadId','claimToken',group_item->>'claimToken','mimeType',group_item->>'mimeType',
       'sizeBytes',group_item->'input'->'intent'->>'sizeBytes','sha256',group_item->'input'->'intent'->>'sha256')))$body$;
 replacement:=$body$public.catalog_upload_command(CASE WHEN group_item ? 'transfer' THEN 'progress-verify-claim' ELSE 'verify-claim' END,group_item->'input',credential,jsonb_build_object(
       'originalUploadId',group_item->>'originalUploadId','claimToken',group_item->>'claimToken','mimeType',group_item->>'mimeType',
       'sizeBytes',group_item->'input'->'intent'->>'sizeBytes','sha256',group_item->'input'->'intent'->>'sha256')||
       CASE WHEN group_item ? 'transfer' THEN jsonb_build_object('transfer',group_item->'transfer') ELSE '{}'::jsonb END))$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small completion group command mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
CREATE FUNCTION catalog_upload_small_completion_v1() RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
REVOKE ALL ON FUNCTION catalog_upload_small_completion_v1() FROM PUBLIC;
