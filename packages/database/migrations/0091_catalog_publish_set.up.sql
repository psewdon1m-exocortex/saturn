-- R03 candidate: one SQL publication of a fully ready existing group of new
-- small files under one parent. No physical effects, new receipt format, guard
-- bypass, worker increase, or per-item call to the former commit function.
LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before set publication migration'; END IF;
END $$;
INSERT INTO sync_extension_function_backup VALUES(91,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));

CREATE FUNCTION catalog_upload_publish_set_v1(credential jsonb,items jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE; d public.devices%ROWTYPE; p public.resources%ROWTYPE;
 root uuid; parent uuid; member_ids uuid[]; group_id uuid; entries jsonb; results jsonb; total_size bigint; event_count bigint;
 chain uuid[]:='{}'; inroot uuid[]:='{}'; cur uuid; n integer:=0; rh integer:=-1; topology jsonb:='[]'; paths jsonb:='[]'; actor jsonb;
BEGIN
 IF jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_array_length(items) NOT BETWEEN 1 AND 4 OR octet_length(items::text)>524288
   OR jsonb_typeof(credential) IS DISTINCT FROM 'object' OR octet_length(credential::text)>512
   OR (SELECT count(*) FROM jsonb_object_keys(credential))<>3 OR NOT credential ?& ARRAY['deviceId','tokenHash','deviceKind']
   OR jsonb_typeof(credential->'deviceId') IS DISTINCT FROM 'string' OR credential->>'deviceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(credential->'tokenHash') IS DISTINCT FROM 'string' OR credential->>'tokenHash' !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(credential->'deviceKind') IS DISTINCT FROM 'string' OR credential->>'deviceKind' NOT IN ('windows_sync','pluto') THEN RAISE EXCEPTION 'invalid_input'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(items) a WHERE jsonb_typeof(a) IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(a))<>3 OR NOT a ?& ARRAY['input','originalUploadId','mimeType']
   OR jsonb_typeof(a->'originalUploadId') IS DISTINCT FROM 'string' OR a->>'originalUploadId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(a->'mimeType') IS DISTINCT FROM 'string' OR length(a->>'mimeType') NOT BETWEEN 1 AND 255
   OR jsonb_typeof(a->'input') IS DISTINCT FROM 'object' OR octet_length((a->'input')::text)>69632
   OR (SELECT count(*) FROM jsonb_object_keys(a->'input'))<>4 OR NOT (a->'input') ?& ARRAY['epoch','bindingVersion','backendIdentity','intent']
   OR jsonb_typeof(a->'input'->'epoch') IS DISTINCT FROM 'string' OR a->'input'->>'epoch' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(a->'input'->'bindingVersion') IS DISTINCT FROM 'string' OR a->'input'->>'bindingVersion' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(a->'input'->'backendIdentity') IS DISTINCT FROM 'string' OR a->'input'->>'backendIdentity' !~ '^[A-Za-z0-9._:-]{1,128}$'
   OR public.catalog_upload_intent_valid(a->'input'->'intent') IS NOT TRUE) THEN RAISE EXCEPTION 'invalid_input'; END IF;
 root:=(items->0->'input'->'intent'->>'rootId')::uuid;parent:=(items->0->'input'->'intent'->>'parentId')::uuid;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(items) a WHERE a->'input'->'intent'->>'rootId' IS DISTINCT FROM root::text
   OR a->'input'->'intent'->>'parentId' IS DISTINCT FROM parent::text
   OR a->'input'->'intent'->>'deviceId' IS DISTINCT FROM credential->>'deviceId'
   OR a->'input'->'intent'->>'deviceKind' IS DISTINCT FROM credential->>'deviceKind'
   OR a->'input'->'intent'->>'schema' IS DISTINCT FROM 'saturn.upload-intent.v2'
   OR a->'input'->'intent'->>'requireAbsent' IS DISTINCT FROM 'true'
   OR a->'input'->'intent'->>'targetId' IS NOT NULL OR a->'input'->'intent'->>'expectedVersionId' IS NOT NULL
   OR (a->'input'->'intent'->>'sizeBytes')::bigint NOT BETWEEN 1 AND 262144) THEN RAISE EXCEPTION 'invalid_input'; END IF;
 member_ids:=ARRAY(SELECT (a->>'originalUploadId')::uuid FROM jsonb_array_elements(items) a);
 IF (SELECT count(DISTINCT id) FROM unnest(member_ids) id)<>cardinality(member_ids) THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=root;
 IF NOT FOUND OR current_user<>g.writer_owner OR session_user<>g.writer_login OR g.writer_contract<>'folder-file-cas-cj04.v1'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(items) a WHERE a->'input'->>'backendIdentity' IS DISTINCT FROM g.backend_identity) THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=root FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 SELECT * INTO d FROM public.devices WHERE id=(credential->>'deviceId')::uuid FOR SHARE;
 SELECT * INTO p FROM public.resources WHERE id=root;
 IF NOT FOUND OR d.id IS NULL OR d.state<>'active' OR NOT d.can_write OR d.token_hash IS DISTINCT FROM credential->>'tokenHash'
   OR d.device_kind IS DISTINCT FROM credential->>'deviceKind' OR d.sync_root_id IS DISTINCT FROM root OR d.scope_ids IS DISTINCT FROM ARRAY[root]
   OR (d.expires_at IS NOT NULL AND d.expires_at<=now()) OR p.status<>'active' OR p.type<>'folder'
   OR p.parent_id IS DISTINCT FROM (CASE WHEN d.device_kind='windows_sync' THEN '00000000-0000-7000-8000-000000000004'::uuid ELSE '00000000-0000-7000-8000-000000000009'::uuid END) THEN RAISE EXCEPTION 'authorization_changed'; END IF;
 PERFORM id FROM public.operation_journal WHERE id=ANY(member_ids) ORDER BY id FOR UPDATE;
 IF (SELECT count(*) FROM public.operation_journal WHERE id=ANY(member_ids))<>cardinality(member_ids)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(items) a JOIN public.operation_journal j ON j.id=(a->>'originalUploadId')::uuid
     WHERE j.idempotency_key IS DISTINCT FROM a->'input'->'intent'->>'idempotencyKey' OR j.sync_root_id IS DISTINCT FROM root
       OR j.upload_execution IS NULL OR j.upload_intent IS DISTINCT FROM a->'input'->'intent'
       OR j.upload_intent_hash IS DISTINCT FROM public.catalog_upload_hash(a->'input'->'intent')
       OR j.upload_execution->>'epoch' IS DISTINCT FROM a->'input'->>'epoch'
       OR j.upload_execution->>'bindingVersion' IS DISTINCT FROM a->'input'->>'bindingVersion'
       OR j.upload_execution->>'backendIdentity' IS DISTINCT FROM a->'input'->>'backendIdentity') THEN RAISE EXCEPTION 'operation_reused'; END IF;
 PERFORM id FROM public.upload_sessions WHERE id=ANY(member_ids) ORDER BY id FOR UPDATE;
 IF (SELECT count(*) FROM public.upload_sessions WHERE id=ANY(member_ids))<>cardinality(member_ids) THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
 SELECT upload_publication_group INTO group_id FROM public.operation_journal WHERE id=member_ids[1];
 IF group_id IS NULL OR EXISTS(SELECT 1 FROM public.operation_journal WHERE id=ANY(member_ids) AND upload_publication_group IS DISTINCT FROM group_id)
   OR NOT EXISTS(SELECT 1 FROM public.catalog_upload_publication_groups cg WHERE cg.id=group_id AND cg.root_id=root
     AND cg.members @> member_ids AND cg.members <@ member_ids
     AND cardinality(cg.members)=cardinality(member_ids)) THEN RAISE EXCEPTION 'reconciliation_required'; END IF;
 -- Terminal lookup precedes mutable epoch, namespace and target checks, exactly
 -- as the original API. The same current device authorization is still required.
 IF NOT EXISTS(SELECT 1 FROM public.operation_journal WHERE id=ANY(member_ids) AND sync_result IS NULL) THEN
   SELECT jsonb_agg(jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object(
     'uploadId',j.id,'operationId',j.id,'rootId',root,'intentHash',j.upload_intent_hash,'expectedSizeBytes',u.expected_size::text,
     'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'result',j.sync_result,'replayed',true) ORDER BY a.ord)
   INTO results FROM jsonb_array_elements(items) WITH ORDINALITY a(value,ord) JOIN public.operation_journal j ON j.id=(a.value->>'originalUploadId')::uuid JOIN public.upload_sessions u ON u.id=j.id;
   RETURN results;
 END IF;
 IF EXISTS(SELECT 1 FROM public.operation_journal j JOIN public.upload_sessions u ON u.id=j.id WHERE j.id=ANY(member_ids)
   AND (j.sync_result IS NOT NULL OR j.upload_effect_state<>'physical_pending' OR j.upload_claim_token IS NULL OR j.upload_transfer IS NOT NULL
     OR u.received_size<>u.expected_size OR u.actual_sha256 IS DISTINCT FROM j.upload_intent->>'sha256'
     OR j.upload_execution->'before' IS DISTINCT FROM 'null'::jsonb OR j.upload_execution->>'archivePath' IS NOT NULL)) THEN RAISE EXCEPTION 'verification_failed'; END IF;
 IF c.descriptor_schema<>'saturn.current-namespace.v1' OR NOT (c.namespace_state='QUALIFYING' OR c.namespace_state='ACTIVE' AND public.catalog_guard_active_valid(g))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(items) a JOIN public.operation_journal j ON j.id=(a->>'originalUploadId')::uuid
     WHERE c.epoch::text IS DISTINCT FROM a->'input'->>'epoch' OR c.binding_version::text IS DISTINCT FROM a->'input'->>'bindingVersion'
       OR j.upload_execution->>'guardRevision' IS DISTINCT FROM g.guard_revision::text) THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL AND NOT j.id=ANY(member_ids)
   AND NOT coalesce(j.upload_execution IS NOT NULL AND j.upload_effect_state IN ('transport','verified'),false)) THEN RAISE EXCEPTION 'reconciliation_required'; END IF;
 -- The existing root serialization remains. Walk a shared parent chain once,
 -- then lock in UUID order and compare the complete locked topology again.
 cur:=parent;
 LOOP
   IF cur=ANY(chain) OR n>130 THEN RAISE EXCEPTION 'membership_changed'; END IF;
   SELECT * INTO p FROM public.resources WHERE id=cur;
   IF NOT FOUND OR p.type<>'folder' OR p.status<>'active' OR (rh<0 AND p.metadata_version IS NULL) OR octet_length(p.storage_path)>4096 THEN RAISE EXCEPTION 'membership_changed'; END IF;
   chain:=array_append(chain,cur);
   IF rh<0 THEN inroot:=array_append(inroot,cur);topology:=topology||jsonb_build_array(jsonb_build_object('nodeId',p.id,'parentId',CASE WHEN p.id=root THEN NULL ELSE p.parent_id END,'name',p.name));paths:=paths||jsonb_build_array(jsonb_build_object('nodeId',p.id,'storagePath',p.storage_path)); END IF;
   IF cur=root THEN rh:=n; END IF;
   IF cur<>root AND EXISTS(SELECT 1 FROM public.sync_root_clock WHERE root_id=cur) THEN RAISE EXCEPTION 'membership_changed'; END IF;
   IF p.parent_id IS NULL THEN EXIT; END IF;cur:=p.parent_id;n:=n+1;
 END LOOP;
 IF cur<>'00000000-0000-7000-8000-000000000001'::uuid OR rh<0 OR rh>=128 THEN RAISE EXCEPTION 'membership_changed'; END IF;
 PERFORM id FROM public.resources WHERE id=ANY(chain) ORDER BY id FOR NO KEY UPDATE;
 IF EXISTS(SELECT 1 FROM unnest(chain) WITH ORDINALITY q(id,ord) LEFT JOIN public.resources r ON r.id=q.id
   WHERE r.id IS NULL OR r.parent_id IS DISTINCT FROM chain[q.ord::integer+1] OR r.type<>'folder' OR r.status<>'active')
   OR (SELECT jsonb_agg(jsonb_build_object('nodeId',r.id,'parentId',CASE WHEN r.id=root THEN NULL ELSE r.parent_id END,'name',r.name) ORDER BY q.ord)
     FROM unnest(inroot) WITH ORDINALITY q(id,ord) JOIN public.resources r ON r.id=q.id) IS DISTINCT FROM topology
   OR (SELECT jsonb_agg(jsonb_build_object('nodeId',r.id,'storagePath',r.storage_path) ORDER BY q.ord)
     FROM unnest(inroot) WITH ORDINALITY q(id,ord) JOIN public.resources r ON r.id=q.id) IS DISTINCT FROM paths THEN RAISE EXCEPTION 'membership_changed'; END IF;
 SELECT * INTO p FROM public.resources WHERE id=parent;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(items) a JOIN public.operation_journal j ON j.id=(a->>'originalUploadId')::uuid
   WHERE a->'input'->'intent'->'parentTopology' IS DISTINCT FROM topology OR j.upload_execution->'pathTopology' IS DISTINCT FROM paths
     OR j.upload_execution->>'targetPath' IS DISTINCT FROM rtrim(p.storage_path,'/')||'/'||(j.upload_intent->>'name')
     OR octet_length(j.upload_execution->>'targetPath')>4096) THEN RAISE EXCEPTION 'membership_changed'; END IF;
 IF (SELECT count(DISTINCT lower(a->'input'->'intent'->>'name')) FROM jsonb_array_elements(items) a)<>cardinality(member_ids)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(items) a JOIN public.resources r ON r.parent_id=parent AND lower(r.name)=lower(a->'input'->'intent'->>'name') AND r.status<>'trashed') THEN RAISE EXCEPTION 'precondition_failed'; END IF;
 event_count:=cardinality(member_ids)::bigint*(cardinality(inroot)+1);
 IF c.published_seq>9223372036854775807-event_count THEN RAISE EXCEPTION 'counter_exhausted'; END IF;
 SELECT sum(u.expected_size),jsonb_agg(jsonb_build_object('id',j.id,'node',(j.upload_execution->>'nodeId')::uuid,'version',(j.upload_execution->>'versionId')::uuid,
   'name',j.upload_intent->>'name','target',j.upload_execution->>'targetPath','size',u.expected_size,'sha',u.actual_sha256,'mime',a.value->>'mimeType','hash',j.upload_intent_hash,
   'firstSeq',c.published_seq+(a.ord-1)*(cardinality(inroot)+1)+1,'lastSeq',c.published_seq+a.ord*(cardinality(inroot)+1)) ORDER BY a.ord)
 INTO total_size,entries FROM jsonb_array_elements(items) WITH ORDINALITY a(value,ord) JOIN public.operation_journal j ON j.id=(a.value->>'originalUploadId')::uuid JOIN public.upload_sessions u ON u.id=j.id;
 actor:=jsonb_build_object('type','device_token','id',credential->>'deviceId');
 INSERT INTO public.resources(id,type,parent_id,name,storage_path,mime_type,size_bytes,sha256,status,sync_availability,current_version_id)
 SELECT x.node,'file',parent,x.name,x.target,x.mime,x.size,x.sha,'active','AVAILABLE',x.version
 FROM jsonb_to_recordset(entries) x(node uuid,version uuid,name text,target text,mime text,size bigint,sha text);
 INSERT INTO public.file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason)
 SELECT x.version,x.node,x.target,x.sha,x.size,x.mime,'initial' FROM jsonb_to_recordset(entries) x(version uuid,node uuid,target text,sha text,size bigint,mime text);
 -- One final ancestor projection for the atomic SQL set. Every original still
 -- owns a contiguous event range including those final ancestor descriptions.
 -- Repeated equal descriptions are idempotent; no intermediate uncommitted
 -- ancestor size is exposed as the final state of the group.
 UPDATE public.resources SET size_bytes=size_bytes+total_size,updated_at=now() WHERE id=ANY(chain);
 WITH source AS(SELECT * FROM jsonb_to_recordset(entries) x(id uuid,node uuid,"firstSeq" bigint)),
 events AS(
   SELECT x.id,x."firstSeq" seq,r.id node_id,public.catalog_namespace_description(r,root) description,'upload.publish'::text reason FROM source x JOIN public.resources r ON r.id=x.node
   UNION ALL SELECT x.id,x."firstSeq"+a.ord,r.id,public.catalog_namespace_description(r,root),'upload.ancestor' FROM source x
     CROSS JOIN (SELECT id,row_number() OVER(ORDER BY id) ord FROM unnest(inroot) id) a JOIN public.resources r ON r.id=a.id)
 INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document)
 SELECT root,c.epoch,e.seq,e.node_id,e.id,jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',e.node_id,'kind','upsert','description',e.description,'reason',e.reason,'actor',actor) FROM events e ORDER BY e.seq;
 SELECT jsonb_agg(jsonb_build_object('id',x.id,'node',x.node,'version',x.version,'firstSeq',x."firstSeq",'lastSeq',x."lastSeq",'receipt',
   jsonb_build_object('schema','saturn.upload-publication.v1','uploadId',x.id,'operationId',x.id,'intentHash',x.hash,'rootId',root,'resourceId',x.node,'versionId',x.version,
     'parentId',parent,'name',x.name,'sizeBytes',x.size::text,'sha256',x.sha,'etag','"sha256-'||x.sha||'"','publishedAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
   'description',public.catalog_namespace_description(r,root),'hash',x.hash) ORDER BY x."firstSeq") INTO results
 FROM jsonb_to_recordset(entries) x(id uuid,node uuid,version uuid,hash text,name text,size bigint,sha text,"firstSeq" bigint,"lastSeq" bigint)
 JOIN public.resources r ON r.id=x.node JOIN public.file_versions v ON v.id=x.version;
 UPDATE public.upload_sessions u SET status='active',resource_id=x.node,updated_at=now() FROM jsonb_to_recordset(results) x(id uuid,node uuid) WHERE u.id=x.id;
 UPDATE public.operation_journal j SET state='active',resource_id=x.node,upload_effect_state='published',upload_receipt=x.receipt,upload_published_version_id=x.version,
   sync_first_seq=x."firstSeq",sync_last_seq=x."lastSeq",sync_result=jsonb_build_object('schema','saturn.catalog-upload-result.v2','status','PUBLISHED','uploadId',x.id,'operationId',x.id,
     'rootId',root,'intentHash',x.hash,'publicationReceipt',x.receipt,'publishedDescription',x.description,'firstSeq',x."firstSeq"::text,'lastSeq',x."lastSeq"::text),updated_at=now()
 FROM jsonb_to_recordset(results) x(id uuid,node uuid,version uuid,receipt jsonb,description jsonb,hash text,"firstSeq" bigint,"lastSeq" bigint) WHERE j.id=x.id;
 UPDATE public.sync_root_clock SET published_seq=c.published_seq+event_count,updated_at=now() WHERE root_id=root;
 SELECT jsonb_agg(jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object(
   'uploadId',j.id,'operationId',j.id,'rootId',root,'intentHash',j.upload_intent_hash,'expectedSizeBytes',u.expected_size::text,
   'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'result',j.sync_result,'replayed',false) ORDER BY a.ord)
 INTO results FROM jsonb_array_elements(items) WITH ORDINALITY a(value,ord) JOIN public.operation_journal j ON j.id=(a.value->>'originalUploadId')::uuid JOIN public.upload_sessions u ON u.id=j.id;
 RETURN results;
END $$;
REVOKE ALL ON FUNCTION catalog_upload_publish_set_v1(jsonb,jsonb) FROM PUBLIC;
DO $install$
DECLARE definition text; marker text; owner_name text;
BEGIN
 definition:=pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure);
 marker:=$body$ IF command='batch' THEN$body$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'set publication predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,$body$ IF command='publish-set' THEN
   IF input IS DISTINCT FROM '{}'::jsonb THEN RAISE EXCEPTION 'invalid_input'; END IF;
   RETURN public.catalog_upload_publish_set_v1(credential,command_payload);
 END IF;
 IF command='batch' THEN$body$);
 FOR owner_name IN SELECT DISTINCT writer_owner FROM public.catalog_guard_roots LOOP
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.catalog_upload_publish_set_v1(jsonb,jsonb) TO %I',owner_name);
 END LOOP;
END $install$;
