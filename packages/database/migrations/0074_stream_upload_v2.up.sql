-- v2 keeps immutable 4MiB parts in indexed rows and returns <=256 ACKs/page.
-- v1 originals and wire shape remain unchanged. No content bytes enter SQL.
CREATE TABLE sync_stream_parts (
 operation_id uuid NOT NULL REFERENCES sync_stream_uploads(operation_id),part_index integer NOT NULL CHECK(part_index>=0),
 chunk jsonb NOT NULL CHECK(octet_length(chunk::text)<=256),state text NOT NULL CHECK(state IN ('PENDING','ACKED')),
 PRIMARY KEY(operation_id,part_index)
);
CREATE INDEX sync_stream_parts_pending ON sync_stream_parts(operation_id,part_index) WHERE state='PENDING';
CREATE FUNCTION sync_stream_part_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.operation_id,NEW.part_index,NEW.chunk) IS DISTINCT FROM ROW(OLD.operation_id,OLD.part_index,OLD.chunk)
   OR OLD.state='ACKED' AND NEW.state<>'ACKED' THEN RAISE EXCEPTION 'operation_reused'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_stream_part_guard BEFORE UPDATE OR DELETE ON sync_stream_parts FOR EACH ROW EXECUTE FUNCTION sync_stream_part_guard();
REVOKE ALL ON sync_stream_parts FROM PUBLIC;
INSERT INTO sync_extension_function_backup VALUES(74,'sync_stream_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('sync_stream_command(text,jsonb,jsonb,jsonb)'::regprocedure));
-- Preserve the explicit role boundary for already installed writer owners.
DO $$ DECLARE role_name name; BEGIN FOR role_name IN SELECT DISTINCT writer_owner FROM catalog_guard_roots LOOP
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON sync_stream_parts TO %I',role_name);
END LOOP; END $$;
CREATE OR REPLACE FUNCTION sync_stream_command(command text,input jsonb,credential jsonb,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_variable
DECLARE s public.sync_stream_uploads%ROWTYPE; g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE;
 v2 boolean := input->>'schema'='saturn.stream-upload.v2'; part public.sync_stream_parts%ROWTYPE; page_after integer; page_last integer; page_chunks jsonb; page_pending jsonb; page_next integer;
 i jsonb:=input->'prepare'->'intent'; valid jsonb; chunk jsonb:=payload->'chunk'; status jsonb; publication jsonb; bytes bigint;
BEGIN
 IF command NOT IN ('prepare','status','chunk','ack','unknown','seal','publication') OR jsonb_typeof(input) IS DISTINCT FROM 'object'
   OR octet_length(input::text)>65536 OR octet_length(payload::text)>65536 OR coalesce(input->>'schema','') NOT IN ('saturn.stream-upload.v1','saturn.stream-upload.v2')
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
     OR NOT EXISTS(SELECT 1 FROM public.sync_root_policy WHERE root_id=g.root_id AND (state='ACTIVE' OR state='PAUSED' AND s.operation_id IS NOT NULL) AND features ? CASE WHEN v2 THEN 'scale-transfer-v2' ELSE 'stream-upload-v1' END) THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 END IF;
 IF command='prepare' AND s.operation_id IS NULL THEN
   bytes:=(i->>'sizeBytes')::bigint;
   IF bytes>coalesce((g.active_runtime->>'maximumFileBytes')::bigint,1073741824) OR bytes>9007199254740991 OR NOT v2 AND bytes>1073741824
     OR NOT v2 AND i->>'deviceKind'='pluto' AND bytes>268435456 THEN RAISE EXCEPTION 'upload_too_large'; END IF;
   IF (SELECT count(*) FROM public.sync_stream_uploads WHERE root_id=g.root_id AND state<>'PUBLISHED')>=4
     OR NOT v2 AND (SELECT coalesce(sum((x.input->'prepare'->'intent'->>'sizeBytes')::bigint),0) FROM public.sync_stream_uploads x WHERE x.root_id=g.root_id AND x.state<>'PUBLISHED')+bytes>1073741824 THEN RAISE EXCEPTION 'capacity'; END IF;
   IF EXISTS(SELECT 1 FROM public.operation_journal WHERE id=(input->>'operationId')::uuid OR idempotency_key=i->>'idempotencyKey') THEN RAISE EXCEPTION 'operation_reused'; END IF;
   INSERT INTO public.sync_stream_uploads(operation_id,root_id,device_id,idempotency_key,input,node_id,version_id)
     VALUES((input->>'operationId')::uuid,g.root_id,(i->>'deviceId')::uuid,i->>'idempotencyKey',input,gen_random_uuid(),gen_random_uuid()) RETURNING * INTO s;
 ELSIF command IN ('chunk','ack','unknown') AND v2 THEN
   IF command='unknown' THEN
     IF EXISTS(SELECT 1 FROM public.sync_stream_parts WHERE operation_id=s.operation_id AND state='PENDING') THEN
       UPDATE public.sync_stream_uploads SET state='UNKNOWN',updated_at=now() WHERE operation_id=s.operation_id RETURNING * INTO s;
     END IF;
   ELSE
     IF jsonb_typeof(chunk) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(chunk))<>4
       OR chunk->>'sha256' !~ '^[a-f0-9]{64}$' OR chunk->>'index' !~ '^(0|[1-9][0-9]{0,9})$'
       OR (chunk->>'index')::numeric>2147483647 OR chunk->>'offset' !~ '^(0|[1-9][0-9]{0,18})$'
       OR chunk->>'length' !~ '^[1-9][0-9]{0,6}$'
       OR (chunk->>'offset')::bigint<>(chunk->>'index')::bigint*4194304
       OR (chunk->>'offset')::bigint>=(i->>'sizeBytes')::bigint
       OR (chunk->>'length')::bigint<>least(4194304,(i->>'sizeBytes')::bigint-(chunk->>'offset')::bigint) THEN RAISE EXCEPTION 'invalid_input'; END IF;
     SELECT * INTO part FROM public.sync_stream_parts WHERE operation_id=s.operation_id AND part_index=(chunk->>'index')::integer;
     IF FOUND AND part.chunk IS DISTINCT FROM chunk THEN RAISE EXCEPTION 'operation_reused'; END IF;
     IF command='chunk' THEN
       IF part.state='ACKED' THEN NULL;
       ELSIF part.operation_id IS NOT NULL OR s.state<>'RECEIVING' THEN RAISE EXCEPTION 'transfer_unresolved';
       ELSE
         -- Creation of the incoming file is an ordered barrier. Later disjoint
         -- offsets may execute in parallel only after chunk zero's durable ACK.
         IF (chunk->>'index')::integer>0 AND NOT EXISTS(SELECT 1 FROM public.sync_stream_parts WHERE operation_id=s.operation_id AND part_index=0 AND state='ACKED') THEN RAISE EXCEPTION 'transfer_unresolved'; END IF;
         IF (SELECT count(*) FROM public.sync_stream_parts WHERE operation_id=s.operation_id AND state='PENDING')>=4 THEN RAISE EXCEPTION 'admission_full'; END IF;
         INSERT INTO public.sync_stream_parts(operation_id,part_index,chunk,state) VALUES(s.operation_id,(chunk->>'index')::integer,chunk,'PENDING');
       END IF;
     ELSIF command='ack' THEN
       IF part.state='PENDING' THEN
         UPDATE public.sync_stream_parts SET state='ACKED' WHERE operation_id=s.operation_id AND part_index=part.part_index;
         UPDATE public.sync_stream_uploads SET received_size=received_size+(chunk->>'length')::bigint,updated_at=now() WHERE operation_id=s.operation_id RETURNING * INTO s;
       ELSIF part.state IS DISTINCT FROM 'ACKED' THEN RAISE EXCEPTION 'transfer_unresolved'; END IF;
     END IF;
   END IF;
 ELSIF command IN ('chunk','ack','unknown') THEN
   IF command='chunk' THEN
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
   END IF;
 ELSIF command='seal' THEN
   IF payload->>'sourceGeneration' IS DISTINCT FROM input->'source'->>'generation' OR payload->>'sourceWitnessSha256' IS DISTINCT FROM input->'source'->>'witnessSha256'
     OR payload->>'sha256' !~ '^[a-f0-9]{64}$' OR v2 AND EXISTS(SELECT 1 FROM public.sync_stream_parts WHERE operation_id=s.operation_id AND state<>'ACKED') OR s.pending_chunk IS NOT NULL OR s.received_size<>(i->>'sizeBytes')::bigint OR s.state='UNKNOWN' THEN RAISE EXCEPTION 'verification_failed'; END IF;
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
 IF v2 THEN
   page_after:=coalesce((payload->>'afterIndex')::integer,(chunk->>'index')::integer-1,-1);
   IF page_after < -1 THEN RAISE EXCEPTION 'invalid_input'; END IF;
   SELECT coalesce(jsonb_agg(p.chunk ORDER BY p.part_index),'[]'::jsonb),max(p.part_index) INTO page_chunks,page_last
     FROM (SELECT part_index,chunk FROM public.sync_stream_parts WHERE operation_id=s.operation_id AND state='ACKED' AND part_index>page_after ORDER BY part_index LIMIT 256) p;
   IF page_last IS NOT NULL AND EXISTS(SELECT 1 FROM public.sync_stream_parts WHERE operation_id=s.operation_id AND state='ACKED' AND part_index>page_last) THEN page_next:=page_last; END IF;
   SELECT coalesce(jsonb_agg(p.chunk ORDER BY p.part_index),'[]'::jsonb) INTO page_pending FROM public.sync_stream_parts p WHERE p.operation_id=s.operation_id AND p.state='PENDING';
   status:=jsonb_build_object('schema','saturn.stream-upload-status.v2','operationId',s.operation_id,'state',s.state,'receivedSizeBytes',s.received_size::text,
     'chunks',page_chunks,'pendingChunks',page_pending,'afterIndex',page_after,'nextIndex',page_next,'finalSha256',s.final_sha256,
     'publication',CASE WHEN publication IS NULL THEN NULL ELSE publication-ARRAY['execution','claimToken'] END);
   RETURN jsonb_build_object('status',status,'sealedPrepare',s.sealed_prepare);
 END IF;
 status:=jsonb_build_object('schema','saturn.stream-upload-status.v1','operationId',s.operation_id,'state',s.state,'receivedSizeBytes',s.received_size::text,'chunks',s.chunks,'pendingChunk',s.pending_chunk,'finalSha256',s.final_sha256,
   'publication',CASE WHEN publication IS NULL THEN NULL ELSE publication-ARRAY['execution','claimToken'] END);
 RETURN jsonb_build_object('status',status,'sealedPrepare',s.sealed_prepare);
END $$;

-- Change numeric representation limits, not immutable admitted originals.
DO $$ DECLARE identity text; definition text; BEGIN
 FOREACH identity IN ARRAY ARRAY['catalog_guard_active_shape_v1(jsonb)','catalog_upload_command(text,jsonb,jsonb,jsonb)'] LOOP
   definition:=pg_get_functiondef(identity::regprocedure);
   INSERT INTO sync_extension_function_backup VALUES(74,identity,definition);
   definition:=replace(definition,'[1-9][0-9]{0,9}','[1-9][0-9]{0,15}');
   definition:=replace(definition,'::numeric>1073741824','::numeric>9007199254740991');
   EXECUTE definition;
 END LOOP;
END $$;
INSERT INTO sync_extension_function_backup VALUES(74,'sync_policy_admission()',pg_get_functiondef('sync_policy_admission()'::regprocedure));
-- The old v2 wire remains byte-identical. New roots enforce their selected
-- codec/policy before any reservation can cause physical I/O.
CREATE OR REPLACE FUNCTION sync_policy_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE root uuid; intent jsonb; p public.sync_root_policy%ROWTYPE; g public.catalog_guard_roots%ROWTYPE;
 b public.sync_backend_executor%ROWTYPE; required_bytes bigint; total_bytes bigint; jobs bigint; large_jobs bigint; backend text;
BEGIN
 IF TG_TABLE_NAME='sync_stream_uploads' THEN root:=NEW.root_id;intent:=NEW.input->'prepare'->'intent';
 ELSE root:=NEW.sync_root_id;intent:=coalesce(NEW.upload_intent,NEW.catalog_intent,NEW.namespace_intent->'input'); END IF;
 IF root IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO p FROM public.sync_root_policy WHERE root_id=root FOR SHARE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF p.state<>'ACTIVE' AND NOT(TG_TABLE_NAME='operation_journal' AND p.state='PAUSED' AND EXISTS(SELECT 1 FROM public.sync_stream_uploads WHERE operation_id=(to_jsonb(NEW)->>'id')::uuid)) THEN RAISE EXCEPTION 'backend_draining'; END IF;
 IF intent ? 'name' AND p.codec='portable_v1' AND (intent->>'name'<>normalize(intent->>'name',NFC)
   OR intent->>'name' ~ '[<>:"|?*]|[. ]$' OR intent->>'name' ~* '^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)') THEN RAISE EXCEPTION 'invalid_name'; END IF;
 IF NOT (TG_TABLE_NAME='sync_stream_uploads' OR intent->>'schema'='saturn.upload-intent.v2' OR intent->>'kind'='clone-content') THEN RETURN NEW; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=root;
 backend:=g.backend_identity;
 SELECT * INTO b FROM public.sync_backend_executor WHERE backend_identity=backend FOR UPDATE;
 IF b.backend_identity IS NULL OR b.state<>'RUNNING' THEN RAISE EXCEPTION 'backend_draining'; END IF;
 required_bytes:=CASE WHEN intent->>'kind'='clone-content' THEN (intent->'source'->>'sizeBytes')::bigint ELSE (intent->>'sizeBytes')::bigint END;
 -- Stream v2 retains at most four 4MiB payloads, independently of file size.
 IF TG_TABLE_NAME='sync_stream_uploads' AND to_jsonb(NEW)->'input'->>'schema'='saturn.stream-upload.v2' THEN required_bytes:=least(required_bytes,16777216); END IF;
 -- A stream's final upload record is the same reservation, not a second job.
 IF TG_TABLE_NAME='operation_journal' AND EXISTS(SELECT 1 FROM public.sync_stream_uploads WHERE operation_id=(to_jsonb(NEW)->>'id')::uuid) THEN RETURN NEW; END IF;
 WITH pending AS (
   SELECT CASE WHEN EXISTS(SELECT 1 FROM public.sync_stream_uploads v WHERE v.operation_id=j.id AND v.input->>'schema'='saturn.stream-upload.v2') THEN least((j.upload_intent->>'sizeBytes')::bigint,16777216) ELSE (j.upload_intent->>'sizeBytes')::bigint END bytes FROM public.operation_journal j JOIN public.catalog_guard_roots x ON x.root_id=j.sync_root_id
     WHERE x.backend_identity=backend AND j.upload_intent IS NOT NULL AND j.sync_result IS NULL
   UNION ALL SELECT CASE WHEN s.input->>'schema'='saturn.stream-upload.v2' THEN least((s.input->'prepare'->'intent'->>'sizeBytes')::bigint,16777216) ELSE (s.input->'prepare'->'intent'->>'sizeBytes')::bigint END FROM public.sync_stream_uploads s JOIN public.catalog_guard_roots x ON x.root_id=s.root_id
     WHERE x.backend_identity=backend AND s.state<>'PUBLISHED' AND NOT EXISTS(SELECT 1 FROM public.operation_journal WHERE id=s.operation_id)
   UNION ALL SELECT (j.namespace_intent->'input'->'source'->>'sizeBytes')::bigint FROM public.operation_journal j JOIN public.catalog_guard_roots x ON x.root_id=j.sync_root_id
     WHERE x.backend_identity=backend AND j.namespace_state<>'PUBLISHED' AND j.namespace_intent->'input'->>'kind'='clone-content'
 ) SELECT coalesce(sum(bytes),0),count(*),count(*) FILTER(WHERE bytes>8388608) INTO total_bytes,jobs,large_jobs FROM pending;
 IF total_bytes+required_bytes>b.maximum_reserved_bytes OR jobs>=(CASE WHEN p.features ? 'scale-transfer-v2' THEN 8 ELSE 4 END) OR required_bytes>8388608 AND large_jobs>=2 THEN RAISE EXCEPTION 'capacity'; END IF;
 RETURN NEW;
END $$;
