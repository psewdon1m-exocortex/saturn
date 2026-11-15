-- Inactive modern folder-v2. No grants, enrollment, ACTIVE, routes or capabilities.
ALTER TABLE operation_journal ADD COLUMN catalog_claim_token uuid;
DO $folder_v2_install$ BEGIN
 EXECUTE replace($folder_v2_ddl$
CREATE FUNCTION catalog_folder_shape_v1(j public.operation_journal) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN j.catalog_intent IS NULL THEN j.catalog_effect_state IS NULL
 ELSE coalesce(
   jsonb_typeof(j.catalog_intent)='object' AND octet_length(j.catalog_intent::text)<=8192
   AND (SELECT count(*) FROM jsonb_object_keys(j.catalog_intent))=13
   AND j.catalog_intent ?& ARRAY['schema','kind','operationId','idempotencyKey','rootId','epoch','bindingVersion','parentId','name','mode','nodeId','backendIdentity','actor']
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(j.catalog_intent) item WHERE item.key<>'actor' AND jsonb_typeof(item.value)<>'string')
   AND j.catalog_intent->>'schema'='saturn.catalog-folder-intent.v1' AND j.catalog_intent->>'kind'='folder.create'
   AND j.operation_type='folder_create' AND j.upload_id IS NULL AND j.upload_intent IS NULL
   AND j.catalog_intent->>'operationId'=j.id::text AND j.idempotency_key='catalog-folder:'||(j.catalog_intent->>'idempotencyKey')
   AND (j.catalog_intent->>'idempotencyKey') ~ '^[A-Za-z0-9._:-]{8,128}$'
   AND j.catalog_intent->>'rootId'=j.sync_root_id::text AND j.catalog_intent->>'epoch'=j.sync_epoch::text
   AND (j.catalog_intent->>'bindingVersion') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND (j.catalog_intent->>'parentId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND (j.catalog_intent->>'nodeId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND (j.catalog_intent->>'backendIdentity') ~ '^[A-Za-z0-9._:-]{1,128}$'
   AND (j.catalog_intent->>'mode') IN ('create','ensure')
   AND octet_length(j.catalog_intent->>'name') BETWEEN 1 AND 1020
   AND (j.catalog_intent->>'name') NOT IN ('.','..') AND (j.catalog_intent->>'name') !~ '[/\\]'
   AND jsonb_typeof(j.catalog_intent->'actor')='object' AND (SELECT count(*) FROM jsonb_object_keys(j.catalog_intent->'actor'))=2
   AND j.catalog_intent->'actor' ?& ARRAY['type','id']
   AND ((j.catalog_intent->'actor'->>'type'='device_token' AND (j.catalog_intent->'actor'->>'id') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
     OR (j.catalog_intent->'actor'->>'type' IN ('owner_web','owner_bootstrap') AND j.catalog_intent->'actor'->>'id'='owner'))
   AND j.catalog_effect_state IN ('prepared','physical_pending','reconciliation_required','published','not_required')
   AND CASE WHEN j.sync_result IS NULL THEN j.catalog_effect_state IN ('prepared','physical_pending','reconciliation_required') AND j.state<>'active' AND j.resource_id IS NULL
   ELSE
     j.state='active' AND jsonb_typeof(j.sync_result)='object' AND octet_length(j.sync_result::text)<=8192
     AND (SELECT count(*) FROM jsonb_object_keys(j.sync_result))=6
     AND j.sync_result ?& ARRAY['schema','operationId','intentHash','rootId','status','description']
     AND NOT EXISTS(SELECT 1 FROM jsonb_each(j.sync_result) item WHERE item.key<>'description' AND jsonb_typeof(item.value)<>'string')
     AND j.sync_result->>'schema'='saturn.catalog-folder-result.v1' AND j.sync_result->>'operationId'=j.id::text
     AND j.sync_result->>'rootId'=j.sync_root_id::text AND j.sync_result->>'intentHash'=j.sync_intent_hash
     AND jsonb_typeof(j.sync_result->'description')='object' AND (SELECT count(*) FROM jsonb_object_keys(j.sync_result->'description'))=9
     AND j.sync_result->'description' ?& ARRAY['node_id','parent_id','name','type','size_bytes','content_sha256','content_version_id','version','availability']
     AND NOT EXISTS(SELECT 1 FROM jsonb_each(j.sync_result->'description') item WHERE item.key NOT IN ('content_sha256','content_version_id') AND jsonb_typeof(item.value)<>'string')
     AND j.sync_result->'description'->>'type'='folder' AND j.sync_result->'description'->>'node_id'=j.resource_id::text
     AND j.sync_result->'description'->>'parent_id'=j.catalog_intent->>'parentId'
     AND lower(j.sync_result->'description'->>'name')=lower(j.catalog_intent->>'name')
     AND octet_length(j.sync_result->'description'->>'name') BETWEEN 1 AND 1020
     AND jsonb_typeof(j.sync_result->'description'->'size_bytes')='string'
     AND (j.sync_result->'description'->>'size_bytes') ~ '^(0|[1-9][0-9]{0,18})$'
     AND CASE WHEN (j.sync_result->'description'->>'size_bytes') ~ '^(0|[1-9][0-9]{0,18})$' THEN (j.sync_result->'description'->>'size_bytes')::numeric<=9223372036854775807 ELSE false END
     AND j.sync_result->'description'->'content_sha256'='null'::jsonb AND j.sync_result->'description'->'content_version_id'='null'::jsonb
     AND (j.sync_result->'description'->>'version') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
     AND (j.sync_result->'description'->>'availability') IN ('AVAILABLE','UNAVAILABLE','UNKNOWN')
     AND ((j.sync_result->>'status'='CREATED' AND j.catalog_effect_state='published'
       AND j.sync_result->'description'->>'node_id'=j.catalog_intent->>'nodeId'
       AND j.sync_result->'description'->>'size_bytes'='0' AND j.sync_result->'description'->>'availability'='AVAILABLE'
       AND j.sync_first_seq IS NOT NULL AND j.sync_last_seq IS NOT NULL AND j.sync_first_seq>0 AND j.sync_last_seq>=j.sync_first_seq)
     OR (j.sync_result->>'status'='EXISTING' AND j.catalog_effect_state='not_required' AND j.catalog_intent->>'mode'='ensure'
       AND j.sync_first_seq IS NULL AND j.sync_last_seq IS NULL))
   END,false) END
$$;

CREATE FUNCTION catalog_folder_v2_intent_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE entry jsonb; prior text; seen text[]:='{}'; n integer:=0; legacy public.operation_journal;
BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR octet_length(i::text)>65536 OR (SELECT count(*) FROM jsonb_object_keys(i))<>14
   OR i->>'schema' IS DISTINCT FROM 'saturn.catalog-folder-intent.v2' OR i->'actor'->>'type' IS DISTINCT FROM 'device_token'
   OR jsonb_typeof(i->'parentTopology') IS DISTINCT FROM 'array' OR jsonb_array_length(i->'parentTopology') NOT BETWEEN 1 AND 129 THEN RETURN false; END IF;
 legacy:=jsonb_populate_record(NULL::public.operation_journal,jsonb_build_object('id',i->>'operationId','operation_type','folder_create','state','created','idempotency_key','catalog-folder:'||(i->>'idempotencyKey'),
   'payload','{}'::jsonb,'sync_root_id',i->>'rootId','sync_epoch',i->>'epoch','sync_intent_hash',repeat('0',64),'catalog_intent',(i-'parentTopology')||jsonb_build_object('schema','saturn.catalog-folder-intent.v1'),'catalog_effect_state','prepared'));
 IF public.catalog_folder_shape_v1(legacy) IS DISTINCT FROM true OR length(i->>'name')>255 OR i->>'name' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(i->'parentTopology') LOOP
   IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(entry))<>3 OR NOT entry ?& ARRAY['nodeId','parentId','name']
     OR jsonb_typeof(entry->'nodeId') IS DISTINCT FROM 'string' OR entry->>'nodeId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
     OR entry->>'nodeId'=ANY(seen) OR jsonb_typeof(entry->'name') IS DISTINCT FROM 'string' OR length(entry->>'name') NOT BETWEEN 1 AND 255
     OR entry->>'name' IN ('.','..') OR entry->>'name' ~ '[/\\]|[[:cntrl:]]' THEN RETURN false; END IF;
   IF n=0 AND entry->>'nodeId' IS DISTINCT FROM i->>'parentId' OR n>0 AND entry->>'nodeId' IS DISTINCT FROM prior THEN RETURN false; END IF;
   IF n=jsonb_array_length(i->'parentTopology')-1 THEN
     IF entry->>'nodeId' IS DISTINCT FROM i->>'rootId' OR entry->'parentId' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
   ELSIF jsonb_typeof(entry->'parentId') IS DISTINCT FROM 'string' OR entry->>'parentId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
   seen:=array_append(seen,entry->>'nodeId');prior:=entry->>'parentId';n:=n+1;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION catalog_folder_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT encode(sha256(convert_to('['||string_agg(to_json(v)::text,',' ORDER BY n)||CASE WHEN i->>'schema'='saturn.catalog-folder-intent.v2' THEN ','||public.catalog_upload_topology_hash_input(i) ELSE '' END||']','UTF8')),'hex')
 FROM unnest(ARRAY[i->>'schema',i->>'kind',i->>'operationId',i->>'idempotencyKey',i->>'rootId',i->>'epoch',i->>'bindingVersion',i->>'backendIdentity',i->>'parentId',i->>'name',i->>'mode',i->>'nodeId',i->'actor'->>'type',i->'actor'->>'id']) WITH ORDINALITY AS x(v,n)
$$;
CREATE OR REPLACE FUNCTION catalog_folder_shape(j public.operation_journal) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE legacy public.operation_journal; entry jsonb; n integer:=0;
BEGIN
 IF j.catalog_intent->>'schema' IS DISTINCT FROM 'saturn.catalog-folder-intent.v2' THEN RETURN j.catalog_claim_token IS NULL AND public.catalog_folder_shape_v1(j); END IF;
 IF NOT public.catalog_folder_v2_intent_valid(j.catalog_intent) OR j.sync_intent_hash IS DISTINCT FROM public.catalog_folder_hash(j.catalog_intent) THEN RETURN false; END IF;
 legacy:=j;legacy.catalog_intent:=(j.catalog_intent-'parentTopology')||jsonb_build_object('schema','saturn.catalog-folder-intent.v1');
 IF j.sync_result IS NOT NULL THEN
   IF j.sync_result->>'schema' IS DISTINCT FROM 'saturn.catalog-folder-result.v2' THEN RETURN false; END IF;
   legacy.sync_result:=j.sync_result||jsonb_build_object('schema','saturn.catalog-folder-result.v1');
 END IF;
 IF public.catalog_folder_shape_v1(legacy) IS DISTINCT FROM true OR (j.catalog_effect_state IN ('physical_pending','reconciliation_required','published')) IS DISTINCT FROM (j.catalog_claim_token IS NOT NULL)
   OR jsonb_typeof(j.payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(j.payload))<>2 OR NOT j.payload ?& ARRAY['storagePath','pathTopology']
   OR jsonb_typeof(j.payload->'storagePath') IS DISTINCT FROM 'string' OR octet_length(j.payload->>'storagePath') NOT BETWEEN 1 AND 4096
   OR jsonb_typeof(j.payload->'pathTopology') IS DISTINCT FROM 'array' OR jsonb_array_length(j.payload->'pathTopology')<>jsonb_array_length(j.catalog_intent->'parentTopology') THEN RETURN false; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(j.payload->'pathTopology') LOOP
   IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(entry))<>2 OR NOT entry ?& ARRAY['nodeId','storagePath']
     OR entry->>'nodeId' IS DISTINCT FROM j.catalog_intent->'parentTopology'->n->>'nodeId'
     OR jsonb_typeof(entry->'storagePath') IS DISTINCT FROM 'string' OR octet_length(entry->>'storagePath') NOT BETWEEN 1 AND 4096
     OR entry->>'storagePath' ~ '[[:cntrl:]]|(^|/)\.{1,2}(/|$)|\\' THEN RETURN false; END IF;n:=n+1;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION guard_catalog_folder_v2_claim() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF OLD.catalog_intent->>'schema'='saturn.catalog-folder-intent.v2' THEN
   IF TG_OP='DELETE' OR (NEW.catalog_claim_token IS DISTINCT FROM OLD.catalog_claim_token AND NOT
     (OLD.catalog_claim_token IS NULL AND NEW.catalog_claim_token IS NOT NULL AND OLD.catalog_effect_state='prepared' AND NEW.catalog_effect_state='physical_pending')) THEN
     RAISE EXCEPTION 'Sealed modern folder claim is immutable' USING ERRCODE='55000'; END IF;
 END IF;IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER operation_catalog_folder_v2_claim_guard BEFORE UPDATE OR DELETE ON operation_journal FOR EACH ROW EXECUTE FUNCTION guard_catalog_folder_v2_claim();
CREATE FUNCTION catalog_folder_v2_stored(j public.operation_journal,replayed boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('intent',j.catalog_intent,'storagePath',j.payload->>'storagePath','phase',j.catalog_effect_state,'claimToken',j.catalog_claim_token,'replayed',replayed)
   ||CASE WHEN j.sync_result IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('result',j.sync_result) END
$$;

CREATE FUNCTION catalog_folder_v2_command(command text,i jsonb,credential jsonb,command_payload jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE; j public.operation_journal%ROWTYPE;
 d public.devices%ROWTYPE; parent public.resources%ROWTYPE; child public.resources%ROWTYPE;
 chain uuid[]:='{}'; cur uuid; nextid uuid; n integer:=0; rh integer:=-1; h text; storage text; descj jsonb; resultj jsonb; seq bigint; actor jsonb; topology jsonb:='[]'::jsonb; paths jsonb:='[]'::jsonb; rowv public.resources%ROWTYPE;
BEGIN
 IF (SELECT namespace_row.nspname FROM pg_class class_row JOIN pg_namespace namespace_row ON namespace_row.oid=class_row.relnamespace WHERE class_row.oid='public.catalog_guard_roots'::regclass) IS DISTINCT FROM 'public'
   THEN RAISE EXCEPTION 'catalog guard command requires qualified public namespace' USING ERRCODE='42501'; END IF;
 IF command IS NULL OR command NOT IN ('reserve','claim','commit','inspect','unknown') OR jsonb_typeof(i) IS DISTINCT FROM 'object' OR octet_length(i::text)>65536 OR jsonb_typeof(command_payload) IS DISTINCT FROM 'object' OR octet_length(command_payload::text)>256
   OR jsonb_typeof(credential) IS DISTINCT FROM 'object' OR octet_length(credential::text)>512 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(credential))<>3 OR NOT credential ?& ARRAY['deviceId','tokenHash','deviceKind']
   OR EXISTS(SELECT 1 FROM jsonb_each(credential) WHERE jsonb_typeof(value)<>'string')
   OR credential->>'deviceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR credential->>'tokenHash' !~ '^[a-f0-9]{64}$' OR credential->>'deviceKind' NOT IN ('windows_sync','pluto')
   THEN RAISE EXCEPTION 'authority_invalid' USING ERRCODE='42501'; END IF;
 IF command IN ('claim','commit','unknown') THEN
   IF (SELECT count(*) FROM jsonb_object_keys(command_payload))<>1 OR jsonb_typeof(command_payload->'claimToken') IS DISTINCT FROM 'string'
     OR command_payload->>'claimToken' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 ELSIF command_payload<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=(i->>'rootId')::uuid;
 IF NOT FOUND OR current_user<>g.writer_owner OR session_user<>g.writer_login OR i->>'backendIdentity'<>g.backend_identity OR g.writer_contract<>'folder-file-cas-cj04.v1'
   THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='42501'; END IF;
 h:=public.catalog_folder_hash(i);actor:=i->'actor';
 IF actor->>'type' IS DISTINCT FROM 'device_token' OR actor->>'id' IS DISTINCT FROM credential->>'deviceId'
   OR NOT public.catalog_folder_v2_intent_valid(i)
   OR i->>'name' ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=g.root_id FOR UPDATE;
 -- Retaining UNKNOWN must work even after current authority is revoked; it cannot publish an effect.
 IF command<>'unknown' THEN
   SELECT * INTO d FROM public.devices WHERE id=(credential->>'deviceId')::uuid FOR SHARE;
   SELECT * INTO parent FROM public.resources WHERE id=g.root_id;
   IF NOT FOUND OR d.id IS NULL OR d.state<>'active' OR NOT d.can_write OR d.token_hash IS DISTINCT FROM credential->>'tokenHash'
     OR d.device_kind IS DISTINCT FROM credential->>'deviceKind' OR d.device_kind NOT IN ('windows_sync','pluto')
     OR d.sync_root_id IS DISTINCT FROM g.root_id OR d.scope_ids IS DISTINCT FROM ARRAY[g.root_id]
     OR (d.expires_at IS NOT NULL AND d.expires_at<=now()) OR parent.status<>'active' OR parent.type<>'folder'
     OR parent.parent_id IS DISTINCT FROM (CASE WHEN d.device_kind='windows_sync' THEN '00000000-0000-7000-8000-000000000004'::uuid ELSE '00000000-0000-7000-8000-000000000009'::uuid END)
     THEN RAISE EXCEPTION 'authorization_changed' USING ERRCODE='42501'; END IF;
 END IF;
 IF (SELECT count(*) FROM public.operation_journal WHERE id=(i->>'operationId')::uuid OR idempotency_key='catalog-folder:'||(i->>'idempotencyKey'))>1
   THEN RAISE EXCEPTION 'operation_reused' USING ERRCODE='55000'; END IF;
 SELECT * INTO j FROM public.operation_journal WHERE id=(i->>'operationId')::uuid OR idempotency_key='catalog-folder:'||(i->>'idempotencyKey') ORDER BY id FOR UPDATE;
 IF FOUND THEN
   IF j.id::text<>i->>'operationId' OR j.idempotency_key<>'catalog-folder:'||(i->>'idempotencyKey') OR j.catalog_intent IS NULL
     OR (command='reserve' AND (j.catalog_intent-'nodeId') IS DISTINCT FROM (i-'nodeId'))
     OR (command<>'reserve' AND j.catalog_intent IS DISTINCT FROM i) OR j.sync_intent_hash<>public.catalog_folder_hash(j.catalog_intent)
     THEN RAISE EXCEPTION 'operation_reused' USING ERRCODE='55000'; END IF;
   i:=j.catalog_intent;h:=j.sync_intent_hash;
   IF j.sync_result IS NOT NULL THEN RETURN public.catalog_folder_v2_stored(j,true); END IF;
 ELSIF command<>'reserve' THEN RAISE EXCEPTION 'operation_reused' USING ERRCODE='55000';
 END IF;
 IF command='inspect' THEN RETURN public.catalog_folder_v2_stored(j,true); END IF;
 IF command='unknown' THEN
   IF j.catalog_claim_token::text IS DISTINCT FROM command_payload->>'claimToken' OR j.catalog_effect_state NOT IN ('physical_pending','reconciliation_required') THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   UPDATE public.operation_journal SET catalog_effect_state='reconciliation_required',error_code='reconciliation_required',updated_at=now() WHERE id=j.id;
   UPDATE public.sync_root_clock SET namespace_state='BACKEND_UNCERTAIN',updated_at=now() WHERE root_id=g.root_id AND namespace_state IN ('QUALIFYING','ACTIVE'); SELECT * INTO j FROM public.operation_journal WHERE id=j.id; RETURN public.catalog_folder_v2_stored(j,false);
 END IF;
 IF c.epoch::text<>i->>'epoch' OR c.binding_version::text<>i->>'bindingVersion' OR c.namespace_state<>'QUALIFYING'
   OR c.descriptor_schema<>'saturn.current-namespace.v1' THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.operation_journal WHERE sync_root_id=g.root_id AND sync_result IS NULL AND id<>(i->>'operationId')::uuid
     AND NOT (g.writer_contract='folder-file-cas-cj04.v1' AND public.catalog_upload_transport(operation_journal)))
   THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
 -- Immutable append-only topology is enforced by invoker guards; lock ordering clock -> auth -> operation -> sorted ancestors.
 cur:=(i->>'parentId')::uuid;
 LOOP
   IF cur=ANY(chain) OR n>130 THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
   SELECT * INTO parent FROM public.resources WHERE id=cur LIMIT 1;
   IF NOT FOUND OR parent.type<>'folder' OR parent.status<>'active' OR (rh<0 AND parent.metadata_version IS NULL) OR octet_length(parent.name)>1020
     OR octet_length(parent.storage_path)>32768 THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
   chain:=array_append(chain,cur);
   IF cur=g.root_id THEN rh:=n; END IF;
   IF cur<>g.root_id AND EXISTS(SELECT 1 FROM public.sync_root_clock WHERE root_id=cur) THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
   IF parent.parent_id IS NULL THEN EXIT; END IF;
   cur:=parent.parent_id;n:=n+1;
 END LOOP;
 -- Snapshot/public namespace max depth128 includes the new leaf, not only its parent.
 IF cur<>'00000000-0000-7000-8000-000000000001'::uuid OR rh<0 OR rh>=128 THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
 PERFORM id FROM public.resources WHERE id=ANY(chain) ORDER BY id FOR NO KEY UPDATE;
 FOR n IN 1..rh+1 LOOP
   SELECT * INTO rowv FROM public.resources WHERE id=chain[n] LIMIT 1;
   IF rowv.id IS NULL OR rowv.status<>'active' OR rowv.type<>'folder' OR rowv.metadata_version IS NULL THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
   topology:=topology||jsonb_build_array(jsonb_build_object('nodeId',rowv.id,'parentId',CASE WHEN rowv.id=g.root_id THEN NULL ELSE rowv.parent_id END,'name',rowv.name));
   paths:=paths||jsonb_build_array(jsonb_build_object('nodeId',rowv.id,'storagePath',rowv.storage_path));
 END LOOP;
 IF topology IS DISTINCT FROM i->'parentTopology' OR (j.id IS NOT NULL AND paths IS DISTINCT FROM j.payload->'pathTopology') THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
 SELECT * INTO parent FROM public.resources WHERE id=(i->>'parentId')::uuid;
 storage:=rtrim(parent.storage_path,'/')||'/'||(i->>'name');
 IF octet_length(storage)>4096 OR (j.id IS NOT NULL AND j.payload->>'storagePath' IS DISTINCT FROM storage) THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
 IF command='reserve' THEN
   IF j.id IS NOT NULL AND j.catalog_effect_state<>'prepared' THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   SELECT * INTO child FROM public.resources WHERE parent_id=parent.id AND lower(name)=lower(i->>'name') AND status='active' LIMIT 1;
   IF FOUND AND (child.type<>'folder' OR i->>'mode'<>'ensure') THEN RAISE EXCEPTION 'conflict' USING ERRCODE='23505'; END IF;
   IF j.id IS NULL THEN
     INSERT INTO public.operation_journal(id,operation_type,state,idempotency_key,payload,sync_root_id,sync_epoch,sync_intent_hash,catalog_intent,catalog_effect_state)
       VALUES((i->>'operationId')::uuid,'folder_create','created','catalog-folder:'||(i->>'idempotencyKey'),jsonb_build_object('storagePath',storage,'pathTopology',paths),g.root_id,c.epoch,h,i,'prepared');
   END IF;
   IF child.id IS NOT NULL THEN
     IF child.metadata_version IS NULL THEN RAISE EXCEPTION 'projection_mismatch' USING ERRCODE='55000'; END IF;
     descj:=jsonb_build_object('node_id',child.id,'parent_id',child.parent_id,'name',child.name,'type','folder','size_bytes',child.size_bytes::text,
       'content_sha256',NULL,'content_version_id',NULL,'version',child.metadata_version,'availability',coalesce(child.sync_availability,'UNKNOWN'));
     resultj:=jsonb_build_object('schema','saturn.catalog-folder-result.v2','operationId',i->>'operationId','intentHash',h,'rootId',g.root_id,'status','EXISTING','description',descj);
     UPDATE public.operation_journal SET state='active',resource_id=child.id,catalog_effect_state='not_required',sync_result=resultj,updated_at=now() WHERE id=(i->>'operationId')::uuid;
     SELECT * INTO j FROM public.operation_journal WHERE id=(i->>'operationId')::uuid; RETURN public.catalog_folder_v2_stored(j,false);
   END IF;
   SELECT * INTO j FROM public.operation_journal WHERE id=(i->>'operationId')::uuid; RETURN public.catalog_folder_v2_stored(j,false);
 ELSIF command='claim' THEN
   IF j.catalog_effect_state<>'prepared' THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   IF c.published_seq=9223372036854775807 THEN RAISE EXCEPTION 'counter_exhausted' USING ERRCODE='55000'; END IF;
   UPDATE public.operation_journal SET catalog_effect_state='physical_pending',catalog_claim_token=(command_payload->>'claimToken')::uuid,state='committing',updated_at=now() WHERE id=j.id;
   SELECT * INTO j FROM public.operation_journal WHERE id=j.id; RETURN public.catalog_folder_v2_stored(j,false);
 ELSIF command='commit' THEN
   IF j.catalog_claim_token::text IS DISTINCT FROM command_payload->>'claimToken' OR j.catalog_effect_state<>'physical_pending' THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   INSERT INTO public.resources(id,type,parent_id,name,storage_path,status,sync_availability)
     VALUES((i->>'nodeId')::uuid,'folder',parent.id,i->>'name',storage,'active','AVAILABLE') RETURNING * INTO child;
   IF c.published_seq=9223372036854775807 THEN RAISE EXCEPTION 'counter_exhausted' USING ERRCODE='55000'; END IF; seq:=c.published_seq+1;
   descj:=jsonb_build_object('node_id',child.id,'parent_id',child.parent_id,'name',child.name,'type','folder','size_bytes',child.size_bytes::text,
     'content_sha256',NULL,'content_version_id',NULL,'version',child.metadata_version,'availability','AVAILABLE');
   resultj:=jsonb_build_object('schema','saturn.catalog-folder-result.v2','operationId',i->>'operationId','intentHash',h,'rootId',g.root_id,'status','CREATED','description',descj);
   INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document) VALUES(g.root_id,c.epoch,seq,child.id,j.id,
     jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',child.id,'kind','upsert','description',descj,'reason','folder.create','actor',actor));
   UPDATE public.operation_journal SET state='active',resource_id=child.id,catalog_effect_state='published',sync_first_seq=seq,sync_last_seq=seq,sync_result=resultj,updated_at=now() WHERE id=j.id;
   UPDATE public.sync_root_clock SET published_seq=seq,updated_at=now() WHERE root_id=g.root_id;
   SELECT * INTO j FROM public.operation_journal WHERE id=j.id; RETURN public.catalog_folder_v2_stored(j,false);
 END IF;
 RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';
END $$;
$folder_v2_ddl$,'public.',quote_ident(current_schema())||'.');END $folder_v2_install$;
ALTER TABLE operation_journal DROP CONSTRAINT operation_catalog_folder_shape;
ALTER TABLE operation_journal ADD CONSTRAINT operation_catalog_folder_shape CHECK(catalog_folder_shape(operation_journal) IS TRUE);
REVOKE ALL ON FUNCTION catalog_folder_v2_command(text,jsonb,jsonb,jsonb) FROM PUBLIC;
