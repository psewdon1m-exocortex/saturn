CREATE TABLE sync_stream_uploads (
 operation_id uuid PRIMARY KEY, root_id uuid NOT NULL REFERENCES sync_root_clock(root_id), device_id uuid NOT NULL REFERENCES devices(id),
 idempotency_key text NOT NULL UNIQUE, input jsonb NOT NULL CHECK(octet_length(input::text)<=65536),
 node_id uuid NOT NULL, version_id uuid NOT NULL, received_size bigint NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'RECEIVING' CHECK(state IN ('RECEIVING','SEALED','PUBLISHING','UNKNOWN','PUBLISHED')),
 chunks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_array_length(chunks)<=256), pending_chunk jsonb,
 final_sha256 text CHECK(final_sha256 ~ '^[a-f0-9]{64}$'), sealed_prepare jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_stream_pending ON sync_stream_uploads(root_id,state) WHERE state<>'PUBLISHED';
CREATE FUNCTION sync_stream_original_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.operation_id,NEW.root_id,NEW.device_id,NEW.idempotency_key,NEW.input,NEW.node_id,NEW.version_id)
    IS DISTINCT FROM ROW(OLD.operation_id,OLD.root_id,OLD.device_id,OLD.idempotency_key,OLD.input,OLD.node_id,OLD.version_id)
    OR OLD.final_sha256 IS NOT NULL AND NEW.final_sha256 IS DISTINCT FROM OLD.final_sha256
    OR OLD.sealed_prepare IS NOT NULL AND NEW.sealed_prepare IS DISTINCT FROM OLD.sealed_prepare
    OR NEW.received_size<OLD.received_size THEN RAISE EXCEPTION 'operation_reused'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_stream_original_guard BEFORE UPDATE OR DELETE ON sync_stream_uploads FOR EACH ROW EXECUTE FUNCTION sync_stream_original_guard();
CREATE FUNCTION sync_stream_command(command text,input jsonb,credential jsonb,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_variable
DECLARE s public.sync_stream_uploads%ROWTYPE; g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE;
 i jsonb:=input->'prepare'->'intent'; valid jsonb; chunk jsonb:=payload->'chunk'; status jsonb; publication jsonb; bytes bigint;
BEGIN
 IF command NOT IN ('prepare','status','chunk','ack','unknown','seal','publication') OR jsonb_typeof(input) IS DISTINCT FROM 'object'
   OR octet_length(input::text)>65536 OR octet_length(payload::text)>65536 OR input->>'schema' IS DISTINCT FROM 'saturn.stream-upload.v1'
   OR input->>'chunkBytes' IS DISTINCT FROM '4194304' OR i->'sha256' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'invalid_input'; END IF;
 valid:=i||jsonb_build_object('sha256',repeat('0',64));
 IF NOT public.catalog_upload_intent_valid(valid) OR i->>'schema'<>'saturn.upload-intent.v2' OR credential->>'deviceId' IS DISTINCT FROM i->>'deviceId'
   OR credential->>'deviceKind' IS DISTINCT FROM i->>'deviceKind' OR input->'source'->>'witnessSha256' !~ '^[a-f0-9]{64}$'
   OR input->'source'->>'generation' !~ '^[!-~]{1,128}$' THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=(i->>'rootId')::uuid;
 IF NOT FOUND OR current_user<>g.writer_owner OR session_user<>g.writer_login OR g.backend_identity IS DISTINCT FROM input->'prepare'->>'backendIdentity' THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=g.root_id FOR UPDATE;
 IF command<>'unknown' THEN PERFORM public.sync_namespace_authorize(g.root_id,'upload',credential); END IF;
 SELECT * INTO s FROM public.sync_stream_uploads WHERE operation_id=(input->>'operationId')::uuid OR idempotency_key=i->>'idempotencyKey' ORDER BY operation_id LIMIT 1 FOR UPDATE;
 IF s.operation_id IS NOT NULL THEN
   IF s.input IS DISTINCT FROM input OR s.operation_id::text IS DISTINCT FROM input->>'operationId' THEN RAISE EXCEPTION 'operation_reused'; END IF;
 ELSIF command<>'prepare' THEN RAISE EXCEPTION 'operation_reused'; END IF;
 IF command NOT IN ('status','unknown') THEN
   IF EXISTS(SELECT 1 FROM public.sync_root_policy WHERE root_id=g.root_id AND state<>'ACTIVE' AND NOT(state='PAUSED' AND s.operation_id IS NOT NULL)) THEN RAISE EXCEPTION 'backend_draining'; END IF;
   IF c.namespace_state<>'ACTIVE' OR NOT public.catalog_guard_active_valid(g) OR c.epoch::text IS DISTINCT FROM input->'prepare'->>'epoch'
     OR c.binding_version::text IS DISTINCT FROM input->'prepare'->>'bindingVersion'
     OR NOT EXISTS(SELECT 1 FROM public.sync_root_policy WHERE root_id=g.root_id AND (state='ACTIVE' OR state='PAUSED' AND s.operation_id IS NOT NULL) AND features ? 'stream-upload-v1') THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 END IF;
 IF command='prepare' AND s.operation_id IS NULL THEN
   bytes:=(i->>'sizeBytes')::bigint;
   IF bytes>coalesce((g.active_runtime->>'maximumFileBytes')::bigint,1073741824) OR bytes>1073741824
     OR i->>'deviceKind'='pluto' AND bytes>268435456 THEN RAISE EXCEPTION 'upload_too_large'; END IF;
   IF (SELECT count(*) FROM public.sync_stream_uploads WHERE root_id=g.root_id AND state<>'PUBLISHED')>=4
     OR (SELECT coalesce(sum((x.input->'prepare'->'intent'->>'sizeBytes')::bigint),0) FROM public.sync_stream_uploads x WHERE x.root_id=g.root_id AND x.state<>'PUBLISHED')+bytes>1073741824 THEN RAISE EXCEPTION 'capacity'; END IF;
   IF EXISTS(SELECT 1 FROM public.operation_journal WHERE id=(input->>'operationId')::uuid OR idempotency_key=i->>'idempotencyKey') THEN RAISE EXCEPTION 'operation_reused'; END IF;
   INSERT INTO public.sync_stream_uploads(operation_id,root_id,device_id,idempotency_key,input,node_id,version_id)
     VALUES((input->>'operationId')::uuid,g.root_id,(i->>'deviceId')::uuid,i->>'idempotencyKey',input,gen_random_uuid(),gen_random_uuid()) RETURNING * INTO s;
 ELSIF command='chunk' THEN
   IF s.state<>'RECEIVING' OR s.pending_chunk IS NOT NULL THEN RAISE EXCEPTION 'transfer_unresolved'; END IF;
   IF jsonb_typeof(chunk)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(chunk))<>4 OR chunk->>'sha256' !~ '^[a-f0-9]{64}$'
     OR chunk->>'index' !~ '^(0|[1-9][0-9]{0,2})$' OR chunk->>'offset' !~ '^(0|[1-9][0-9]{0,18})$' OR chunk->>'length' !~ '^[1-9][0-9]{0,6}$' THEN RAISE EXCEPTION 'invalid_input'; END IF;
   IF (chunk->>'index')::integer<jsonb_array_length(s.chunks) THEN
     IF s.chunks->(chunk->>'index')::integer IS DISTINCT FROM chunk THEN RAISE EXCEPTION 'operation_reused'; END IF;
   ELSE
     IF (chunk->>'index')::integer<>jsonb_array_length(s.chunks) OR chunk->>'offset'<>s.received_size::text
       OR (chunk->>'length')::bigint<>least(4194304,(i->>'sizeBytes')::bigint-s.received_size) THEN RAISE EXCEPTION 'invalid_input'; END IF;
     UPDATE public.sync_stream_uploads SET pending_chunk=chunk,updated_at=now() WHERE operation_id=s.operation_id RETURNING * INTO s;
   END IF;
 ELSIF command='ack' THEN
   IF s.pending_chunk IS NOT DISTINCT FROM chunk AND s.state='RECEIVING' THEN
     UPDATE public.sync_stream_uploads SET chunks=chunks||jsonb_build_array(chunk),received_size=received_size+(chunk->>'length')::bigint,pending_chunk=NULL,updated_at=now() WHERE operation_id=s.operation_id RETURNING * INTO s;
   ELSIF s.chunks->(chunk->>'index')::integer IS DISTINCT FROM chunk THEN RAISE EXCEPTION 'transfer_unresolved'; END IF;
 ELSIF command='unknown' THEN
   IF s.pending_chunk IS NOT NULL THEN UPDATE public.sync_stream_uploads SET state='UNKNOWN',updated_at=now() WHERE operation_id=s.operation_id RETURNING * INTO s; END IF;
 ELSIF command='seal' THEN
   IF payload->>'sourceGeneration' IS DISTINCT FROM input->'source'->>'generation' OR payload->>'sourceWitnessSha256' IS DISTINCT FROM input->'source'->>'witnessSha256'
     OR payload->>'sha256' !~ '^[a-f0-9]{64}$' OR s.pending_chunk IS NOT NULL OR s.received_size<>(i->>'sizeBytes')::bigint OR s.state='UNKNOWN' THEN RAISE EXCEPTION 'verification_failed'; END IF;
   IF s.final_sha256 IS NOT NULL AND s.final_sha256 IS DISTINCT FROM payload->>'sha256' THEN RAISE EXCEPTION 'operation_reused'; END IF;
   IF s.sealed_prepare IS NULL THEN
     valid:=(input->'prepare')||jsonb_build_object('intent',i||jsonb_build_object('sha256',payload->>'sha256'));
     publication:=public.catalog_upload_command('reserve',valid,credential,jsonb_build_object('uploadId',s.operation_id,'nodeId',s.node_id,'versionId',s.version_id,'maximumFileBytes',g.active_runtime->>'maximumFileBytes'));
     -- Every byte is accounted by immutable chunk SHA + physical ACK. Whole
     -- readback and publication CAS still run in the existing upload executor.
     UPDATE public.upload_sessions SET received_size=s.received_size,status='uploading',updated_at=now() WHERE id=s.operation_id;
     UPDATE public.sync_stream_uploads SET final_sha256=payload->>'sha256',sealed_prepare=valid,state='SEALED',updated_at=now() WHERE operation_id=s.operation_id RETURNING * INTO s;
   END IF;
 ELSIF command='publication' THEN
   IF s.sealed_prepare IS NULL THEN RAISE EXCEPTION 'verification_failed'; END IF;
 END IF;
 IF s.sealed_prepare IS NOT NULL THEN
   publication:=public.catalog_upload_command('status',s.sealed_prepare,credential,jsonb_build_object('originalUploadId',s.operation_id));
   IF publication->'result'->>'status'='PUBLISHED' THEN UPDATE public.sync_stream_uploads SET state='PUBLISHED',updated_at=now() WHERE operation_id=s.operation_id RETURNING * INTO s;
   ELSIF publication->'session'->>'phase'='reconciliation_required' THEN UPDATE public.sync_stream_uploads SET state='UNKNOWN',updated_at=now() WHERE operation_id=s.operation_id RETURNING * INTO s;
   ELSIF publication->'session'->>'phase'='physical_pending' THEN UPDATE public.sync_stream_uploads SET state='PUBLISHING',updated_at=now() WHERE operation_id=s.operation_id RETURNING * INTO s; END IF;
 END IF;
 status:=jsonb_build_object('schema','saturn.stream-upload-status.v1','operationId',s.operation_id,'state',s.state,'receivedSizeBytes',s.received_size::text,'chunks',s.chunks,'pendingChunk',s.pending_chunk,'finalSha256',s.final_sha256,
   'publication',CASE WHEN publication IS NULL THEN NULL ELSE publication-ARRAY['execution','claimToken'] END);
 RETURN jsonb_build_object('status',status,'sealedPrepare',s.sealed_prepare);
END $$;
REVOKE ALL ON sync_stream_uploads FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_stream_command(text,jsonb,jsonb,jsonb) FROM PUBLIC;
