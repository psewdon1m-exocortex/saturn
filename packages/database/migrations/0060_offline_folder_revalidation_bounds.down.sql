-- Refuse narrowing while durable originals require the expanded reader.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM operation_journal WHERE operation_type='folder_revalidate' AND (jsonb_array_length(payload->'tree')>500 OR jsonb_array_length(payload->'folders')>500)) THEN
  RAISE EXCEPTION 'Used expanded folder revalidation history cannot be narrowed' USING ERRCODE='55000';
 END IF;
END $$;
DO $install$ BEGIN EXECUTE replace($ddl$
CREATE OR REPLACE FUNCTION catalog_folder_revalidation_input(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text; e jsonb; ids text[]:='{}'; selected text[]:='{}'; b jsonb;
BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR octet_length(i::text)>4194304
   OR (SELECT count(*) FROM jsonb_object_keys(i))<>13
   OR NOT i ?& ARRAY['schema','operationId','idempotencyKey','binding','guardRevision','backendIdentity','deviceId','expectedSeq','observedAt','expiresAt','custody','tree','folders']
   OR i->>'schema' IS DISTINCT FROM 'saturn.catalog-folder-revalidation-intent.v1' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['operationId','guardRevision','deviceId'] LOOP
  IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR i->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 IF i->>'idempotencyKey' IS DISTINCT FROM 'folder-revalidate-'||(i->>'operationId')
   OR jsonb_typeof(i->'backendIdentity') IS DISTINCT FROM 'string' OR i->>'backendIdentity' !~ '^[A-Za-z0-9._:-]{1,128}$'
   OR jsonb_typeof(i->'expectedSeq') IS DISTINCT FROM 'string' OR i->>'expectedSeq' !~ '^(0|[1-9][0-9]{0,18})$'
   OR (i->>'expectedSeq')::numeric>9223372036854775807 THEN RETURN false; END IF;
 b:=i->'binding';
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>7
   OR NOT b ?& ARRAY['protocol','descriptor_schema','server_identity','root_id','server_epoch','policy_version','binding_version']
   OR b->>'protocol' IS DISTINCT FROM 'neptune-sync/1' OR b->>'descriptor_schema' IS DISTINCT FROM 'saturn.current-namespace.v1'
   OR EXISTS(SELECT 1 FROM jsonb_each(b) WHERE jsonb_typeof(value)<>'string')
   OR b->>'server_identity' !~ '^[A-Za-z0-9._:-]{1,128}$' OR b->>'policy_version' !~ '^[A-Za-z0-9._:-]{1,128}$' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['root_id','server_epoch','binding_version'] LOOP
  IF b->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['observedAt','expiresAt'] LOOP
  IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR i->>k !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN RETURN false; END IF;
 END LOOP;
 IF (i->>'expiresAt')::timestamptz<=(i->>'observedAt')::timestamptz OR (i->>'expiresAt')::timestamptz>(i->>'observedAt')::timestamptz+interval '30 seconds' THEN RETURN false; END IF;
 e:=i->'custody';
 IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(e))<>5
   OR NOT e ?& ARRAY['backendGeneration','bootstrapSha256','drainSha256','backupSha256','treeSha256']
   OR EXISTS(SELECT 1 FROM jsonb_each(e) WHERE jsonb_typeof(value)<>'string')
   OR e->>'backendGeneration' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['bootstrapSha256','drainSha256','backupSha256','treeSha256'] LOOP
  IF e->>k !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 END LOOP;
 IF jsonb_typeof(i->'tree') IS DISTINCT FROM 'array' OR jsonb_array_length(i->'tree') NOT BETWEEN 1 AND 500
   OR jsonb_typeof(i->'folders') IS DISTINCT FROM 'array' OR jsonb_array_length(i->'folders') NOT BETWEEN 1 AND 500 THEN RETURN false; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(i->'tree') LOOP
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(e))<>2 OR NOT e ?& ARRAY['description','storagePath']
    OR jsonb_typeof(e->'storagePath') IS DISTINCT FROM 'string' OR octet_length(e->>'storagePath') NOT BETWEEN 1 AND 4096
    OR e->>'storagePath' ~ '(^/|/$|//|\\|[[:cntrl:]]|(^|/)\.\.?(/|$))'
    OR jsonb_typeof(e->'description') IS DISTINCT FROM 'object' OR octet_length((e->'description')::text)>8192
    OR jsonb_typeof(e->'description'->'node_id') IS DISTINCT FROM 'string'
    OR e->'description'->>'node_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR e->'description'->>'node_id'=ANY(ids) THEN RETURN false; END IF;
  ids:=array_append(ids,e->'description'->>'node_id');
 END LOOP;
 IF NOT b->>'root_id'=ANY(ids) THEN RETURN false; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(i->'folders') LOOP
  IF jsonb_typeof(e)<>'string' OR NOT (e#>>'{}')=ANY(ids) OR (e#>>'{}')=ANY(selected) THEN RETURN false; END IF;
  selected:=array_append(selected,e#>>'{}');
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION catalog_folder_revalidation_command(command text,i jsonb,credential jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE; j public.operation_journal%ROWTYPE;
 d public.devices%ROWTYPE; r public.resources%ROWTYPE; event public.sync_root_changes%ROWTYPE; op public.operation_journal%ROWTYPE;
 root uuid; ids uuid[]; treeids uuid[]; actualids uuid[]; e jsonb; description jsonb; previous jsonb; results jsonb:='[]'; h text; seq bigint; firstseq bigint; events bigint; depth integer;
BEGIN
 IF (SELECT n.nspname FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE t.oid='public.catalog_guard_roots'::regclass) IS DISTINCT FROM 'public' THEN RAISE EXCEPTION 'public namespace required' USING ERRCODE='42501'; END IF;
 IF command IS NULL OR command NOT IN ('inspect','commit') OR NOT public.catalog_folder_revalidation_input(i) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(credential) IS DISTINCT FROM 'object' OR octet_length(credential::text)>512 OR (SELECT count(*) FROM jsonb_object_keys(credential))<>3
   OR NOT credential ?& ARRAY['deviceId','tokenHash','deviceKind'] OR EXISTS(SELECT 1 FROM jsonb_each(credential) WHERE jsonb_typeof(value)<>'string')
   OR credential->>'deviceId' IS DISTINCT FROM i->>'deviceId' OR credential->>'tokenHash' !~ '^[a-f0-9]{64}$' OR credential->>'deviceKind' NOT IN ('windows_sync','pluto') THEN RAISE EXCEPTION 'authority_invalid' USING ERRCODE='42501'; END IF;
 root:=(i->'binding'->>'root_id')::uuid; h:=public.catalog_folder_revalidation_hash(i);
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=root;
 IF NOT FOUND OR current_user<>g.writer_owner OR session_user<>g.writer_login OR g.writer_contract<>'folder-file-cas-cj04.v1'
   OR g.guard_revision::text IS DISTINCT FROM i->>'guardRevision' OR g.backend_identity IS DISTINCT FROM i->>'backendIdentity'
   OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN (g.writer_login,g.writer_owner) AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
   OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=g.writer_owner AND NOT rolcanlogin)
   OR pg_has_role(session_user,g.writer_owner,'MEMBER') THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='42501'; END IF;
 -- No ordinary executor can be alive during an offline command. The private
 -- operator grants EXECUTE only for its drained window and revokes it on exit.
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=g.writer_login AND pid<>pg_backend_pid()) THEN RAISE EXCEPTION 'writers_not_drained' USING ERRCODE='55000'; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=root FOR UPDATE;
 IF NOT FOUND OR c.epoch::text IS DISTINCT FROM i->'binding'->>'server_epoch' OR c.binding_version::text IS DISTINCT FROM i->'binding'->>'binding_version'
   OR c.namespace_state<>'QUALIFYING' OR c.descriptor_schema IS DISTINCT FROM i->'binding'->>'descriptor_schema' THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='55000'; END IF;
 SELECT * INTO d FROM public.devices WHERE id=(i->>'deviceId')::uuid FOR SHARE;
 IF NOT FOUND OR d.state<>'active' OR NOT d.can_write OR d.token_hash IS DISTINCT FROM credential->>'tokenHash'
   OR d.device_kind IS DISTINCT FROM credential->>'deviceKind' OR d.sync_root_id IS DISTINCT FROM root OR d.scope_ids IS DISTINCT FROM ARRAY[root]
   OR d.expires_at IS NOT NULL AND d.expires_at<=now() THEN RAISE EXCEPTION 'authorization_changed' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.operation_journal WHERE id=(i->>'operationId')::uuid OR idempotency_key='catalog-folder-revalidate:'||(i->>'idempotencyKey'))>1 THEN RAISE EXCEPTION 'operation_reused' USING ERRCODE='55000'; END IF;
 SELECT * INTO j FROM public.operation_journal WHERE id=(i->>'operationId')::uuid OR idempotency_key='catalog-folder-revalidate:'||(i->>'idempotencyKey') FOR UPDATE;
 IF FOUND THEN
  IF j.operation_type<>'folder_revalidate' OR j.payload IS DISTINCT FROM i OR j.sync_intent_hash<>h OR NOT public.catalog_folder_revalidation_shape(j) THEN RAISE EXCEPTION 'operation_reused' USING ERRCODE='55000'; END IF;
  IF j.sync_result IS NULL THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('replayed',true,'result',j.sync_result);
 END IF;
 IF command='inspect' THEN RETURN jsonb_build_object('replayed',false,'result',NULL); END IF;
 IF clock_timestamp()<(i->>'observedAt')::timestamptz-interval '1 second' OR clock_timestamp()>(i->>'expiresAt')::timestamptz THEN RAISE EXCEPTION 'evidence_expired' USING ERRCODE='55000'; END IF;
 IF c.published_seq<>(i->>'expectedSeq')::bigint THEN RAISE EXCEPTION 'metadata_conflict' USING ERRCODE='55000'; END IF;
 IF c.retained_after_seq<>0 OR c.published_seq>4096 THEN RAISE EXCEPTION 'history_outside_repair_bound' USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO events FROM public.sync_root_changes ch WHERE ch.root_id=root AND ch.epoch=c.epoch AND ch.seq<=c.published_seq;
 IF events<>c.published_seq OR EXISTS(SELECT 1 FROM public.operation_journal WHERE sync_root_id=root AND sync_result IS NULL) THEN RAISE EXCEPTION 'incomplete_history' USING ERRCODE='55000'; END IF;
 SELECT array_agg((value#>>'{}')::uuid ORDER BY value#>>'{}') INTO ids FROM jsonb_array_elements(i->'folders');
 SELECT array_agg((value->'description'->>'node_id')::uuid ORDER BY value->'description'->>'node_id') INTO treeids FROM jsonb_array_elements(i->'tree');
 WITH RECURSIVE tree AS (
  SELECT id,0 AS level,ARRAY[id] AS visited FROM public.resources WHERE id=root
  UNION ALL SELECT child.id,t.level+1,t.visited||child.id FROM tree t JOIN public.resources child ON child.parent_id=t.id WHERE t.level<129 AND NOT child.id=ANY(t.visited)
 ), bounded AS (SELECT id,level FROM tree LIMIT 501)
 SELECT array_agg(id ORDER BY id),max(level) INTO actualids,depth FROM bounded;
 IF actualids IS DISTINCT FROM treeids OR depth>128 THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.sync_root_clock WHERE root_id=ANY(treeids) AND root_id<>root) THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
 PERFORM id FROM public.resources WHERE id=ANY(treeids) ORDER BY id FOR NO KEY UPDATE;
 FOR e IN SELECT value FROM jsonb_array_elements(i->'tree') LOOP
  SELECT * INTO r FROM public.resources WHERE id=(e->'description'->>'node_id')::uuid;
  IF NOT FOUND OR r.status<>'active' OR r.type NOT IN ('file','folder') OR r.storage_path IS DISTINCT FROM e->>'storagePath'
    OR public.catalog_namespace_description(r,root) IS DISTINCT FROM e->'description'
    OR (r.id=ANY(ids) AND (r.type<>'folder' OR r.sync_availability IS DISTINCT FROM 'UNKNOWN'))
    OR (NOT r.id=ANY(ids) AND r.sync_availability IS DISTINCT FROM 'AVAILABLE') THEN RAISE EXCEPTION 'metadata_conflict' USING ERRCODE='55000'; END IF;
  IF r.id=root AND r.parent_id IS DISTINCT FROM (CASE WHEN d.device_kind='windows_sync' THEN '00000000-0000-7000-8000-000000000004'::uuid ELSE '00000000-0000-7000-8000-000000000009'::uuid END) THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOREACH root IN ARRAY ids LOOP
  SELECT * INTO r FROM public.resources WHERE id=root; previous:=NULL;
  IF r.id<>g.root_id AND NOT EXISTS(SELECT 1 FROM public.operation_journal WHERE sync_root_id=g.root_id AND sync_epoch=c.epoch AND resource_id=r.id
    AND catalog_effect_state='published' AND sync_result->>'status'='CREATED' AND catalog_intent->>'backendIdentity'=g.backend_identity
    AND ((sync_result->'description')-ARRAY['size_bytes','version','availability'])=(public.catalog_namespace_description(r,g.root_id)-ARRAY['size_bytes','version','availability'])) THEN RAISE EXCEPTION 'origin_unproved' USING ERRCODE='55000'; END IF;
  FOR event IN SELECT * FROM public.sync_root_changes ch WHERE ch.root_id=g.root_id AND ch.epoch=c.epoch AND ch.node_id=r.id ORDER BY ch.seq LOOP
   IF event.document->>'kind'<>'upsert' OR ((event.document->'description')-ARRAY['size_bytes','version','availability']) IS DISTINCT FROM (public.catalog_namespace_description(r,g.root_id)-ARRAY['size_bytes','version','availability']) THEN RAISE EXCEPTION 'unsupported_unknown_cause' USING ERRCODE='55000'; END IF;
   SELECT * INTO op FROM public.operation_journal WHERE id=event.operation_id;
   IF event.document->>'reason'='folder.create' AND previous IS NULL AND r.id<>g.root_id AND op.catalog_effect_state='published' AND op.sync_result->>'status'='CREATED' AND event.document->'description'->>'availability'='AVAILABLE' THEN NULL;
   ELSIF event.document->>'reason'='upload.ancestor' AND op.upload_effect_state='published' AND op.sync_result->>'status'='PUBLISHED'
     AND op.sync_root_id=g.root_id AND op.sync_epoch=c.epoch AND event.seq BETWEEN op.sync_first_seq AND op.sync_last_seq
     AND op.upload_execution->>'backendIdentity'=g.backend_identity
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(op.upload_execution->'pathTopology') a WHERE a->>'nodeId'=r.id::text AND a->>'storagePath'=r.storage_path) THEN NULL;
   ELSE RAISE EXCEPTION 'unsupported_unknown_cause' USING ERRCODE='55000'; END IF;
   previous:=event.document->'description';
  END LOOP;
  IF previous IS DISTINCT FROM public.catalog_namespace_description(r,g.root_id) THEN RAISE EXCEPTION 'unrecorded_metadata_change' USING ERRCODE='55000'; END IF;
 END LOOP;
 root:=g.root_id;
 IF c.published_seq>9223372036854775807-array_length(ids,1) THEN RAISE EXCEPTION 'counter_exhausted' USING ERRCODE='55000'; END IF;
 INSERT INTO public.operation_journal(id,operation_type,state,idempotency_key,resource_id,payload,sync_root_id,sync_epoch,sync_intent_hash)
  VALUES((i->>'operationId')::uuid,'folder_revalidate','committing','catalog-folder-revalidate:'||(i->>'idempotencyKey'),root,i,root,c.epoch,h);
 seq:=c.published_seq;firstseq:=seq+1;
 FOR r IN SELECT * FROM public.resources WHERE id=ANY(ids) ORDER BY id LOOP
  UPDATE public.resources SET sync_availability='AVAILABLE',updated_at=now() WHERE id=r.id RETURNING public.catalog_namespace_description(resources,root) INTO description;
  IF description->>'version'=r.metadata_version::text THEN RAISE EXCEPTION 'metadata_version_not_renewed' USING ERRCODE='55000'; END IF;
  seq:=seq+1;results:=results||jsonb_build_array(description);
  INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document) VALUES(root,c.epoch,seq,r.id,(i->>'operationId')::uuid,
   jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',r.id,'kind','upsert','description',description,'reason','availability.revalidated','actor',jsonb_build_object('type','device_token','id',d.id)));
 END LOOP;
 UPDATE public.operation_journal SET state='active',sync_first_seq=firstseq,sync_last_seq=seq,sync_result=jsonb_build_object('schema','saturn.catalog-folder-revalidation-result.v1',
  'operationId',i->>'operationId','intentHash',h,'rootId',root,'status','REVALIDATED','firstSeq',firstseq::text,'lastSeq',seq::text,'descriptions',results),updated_at=now() WHERE id=(i->>'operationId')::uuid RETURNING * INTO j;
 UPDATE public.sync_root_clock SET published_seq=seq,updated_at=now() WHERE root_id=root;
 RETURN jsonb_build_object('replayed',false,'result',j.sync_result);
END $$;
$ddl$,'public.',quote_ident(current_schema())||'.'); END $install$;
