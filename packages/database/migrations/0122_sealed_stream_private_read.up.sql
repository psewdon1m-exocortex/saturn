-- A sealed v2 stream accounts bytes in immutable stream-part ACKs rather than
-- upload_last_transfer. Preserve every existing private-read guard and admit
-- only the fully sealed, same-original private stream representation.
SELECT pg_advisory_xact_lock(1397967206);
DO $migration$
DECLARE definition text; needle text; replacement text;
BEGIN
 definition:=pg_get_functiondef('public.catalog_upload_private_read(public.operation_journal)'::regprocedure);
 needle:='IF u.received_size>0 AND j.upload_last_transfer IS NULL THEN RETURN false; END IF;';
 replacement:=$replacement$IF u.received_size>0 AND j.upload_last_transfer IS NULL THEN
   IF j.upload_transfer IS NOT NULL OR NOT EXISTS (
     SELECT 1 FROM public.sync_stream_uploads sealed
     WHERE sealed.operation_id=j.id AND sealed.root_id=j.sync_root_id
       AND sealed.device_id::text=j.upload_intent->>'deviceId'
       AND sealed.idempotency_key=j.idempotency_key
       AND sealed.node_id::text=j.upload_execution->>'nodeId'
       AND sealed.version_id::text=j.upload_execution->>'versionId'
       AND sealed.state='SEALED' AND sealed.input->>'schema'='saturn.stream-upload.v2'
       AND sealed.pending_chunk IS NULL AND sealed.received_size=u.expected_size
       AND sealed.final_sha256=j.upload_intent->>'sha256'
       AND sealed.sealed_prepare->'intent'=j.upload_intent
       AND sealed.sealed_prepare=(sealed.input->'prepare')||jsonb_build_object('intent',
         (sealed.input->'prepare'->'intent')||jsonb_build_object('sha256',sealed.final_sha256))
       AND NOT EXISTS(SELECT 1 FROM public.sync_stream_parts pending WHERE pending.operation_id=j.id AND pending.state<>'ACKED')
       AND EXISTS(SELECT 1 FROM public.sync_stream_parts part WHERE part.operation_id=j.id
         GROUP BY part.operation_id HAVING count(*)=(sealed.received_size+4194303)/4194304
         AND min(part.part_index)=0 AND max(part.part_index)=count(*)-1
         AND sum((part.chunk->>'length')::numeric)=sealed.received_size
         AND bool_and(part.state='ACKED' AND part.chunk->>'index'=part.part_index::text
           AND (part.chunk->>'offset')::numeric=part.part_index::numeric*4194304
           AND (part.chunk->>'length')::numeric=least(4194304,sealed.received_size-part.part_index::bigint*4194304)
           AND part.chunk->>'sha256' ~ '^[a-f0-9]{64}$'))
   ) THEN RETURN false; END IF;
 END IF;$replacement$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'sealed stream private read predecessor changed';
 END IF;
 INSERT INTO public.sync_extension_function_backup(revision,identity,definition)
 VALUES(122,'catalog_upload_private_read(operation_journal)',definition);
 EXECUTE replace(definition,needle,replacement);
END $migration$;
