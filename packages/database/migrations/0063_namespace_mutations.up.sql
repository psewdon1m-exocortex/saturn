-- Qualified namespace writer, preserving the original operation registry.
CREATE TABLE sync_extension_function_backup(revision integer NOT NULL,identity text NOT NULL,definition text NOT NULL,PRIMARY KEY(revision,identity));
INSERT INTO sync_extension_function_backup VALUES(63,'renew_resource_metadata_version()',pg_get_functiondef('renew_resource_metadata_version()'::regprocedure));
REVOKE ALL ON sync_extension_function_backup FROM PUBLIC;
CREATE TABLE sync_root_policy (
 root_id uuid PRIMARY KEY REFERENCES sync_root_clock(root_id), codec text NOT NULL DEFAULT 'legacy' CHECK(codec IN ('legacy','portable_v1')),
 policy_hash text NOT NULL CHECK(policy_hash ~ '^[a-f0-9]{64}$'), policy_version text NOT NULL,
 features jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(features)='array'),
 state text NOT NULL DEFAULT 'PAUSED' CHECK(state IN ('PAUSED','ACTIVE','MIGRATING')),
 minimum_writer text NOT NULL DEFAULT 'saturn.namespace-mutation.v1',
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sync_delete_plans (
 id uuid PRIMARY KEY, root_id uuid NOT NULL REFERENCES sync_root_clock(root_id), digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 binding_version uuid NOT NULL, policy_hash text NOT NULL, items jsonb NOT NULL, actor jsonb NOT NULL,approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE operation_journal ADD COLUMN namespace_intent jsonb;
ALTER TABLE operation_journal ADD COLUMN namespace_execution jsonb;
ALTER TABLE operation_journal ADD COLUMN namespace_state text CHECK(namespace_state IN ('PREPARED','PHYSICAL_PENDING','UNKNOWN','PUBLISHED'));
ALTER TABLE operation_journal ADD COLUMN namespace_claim_token uuid;
CREATE INDEX resources_authorized_content_lookup ON resources(sha256,size_bytes,id) WHERE type='file' AND status='active' AND sync_availability='AVAILABLE';
CREATE FUNCTION sync_namespace_original_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF OLD.namespace_intent IS NOT NULL THEN
   IF TG_OP='DELETE' OR NEW.namespace_intent IS DISTINCT FROM OLD.namespace_intent OR NEW.namespace_execution IS DISTINCT FROM OLD.namespace_execution
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
     OR OLD.namespace_claim_token IS NOT NULL AND NEW.namespace_claim_token IS DISTINCT FROM OLD.namespace_claim_token
     OR OLD.namespace_state='PUBLISHED' AND NEW.namespace_state<>'PUBLISHED' THEN RAISE EXCEPTION 'operation_reused'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER sync_namespace_original_guard BEFORE UPDATE OR DELETE ON operation_journal FOR EACH ROW EXECUTE FUNCTION sync_namespace_original_guard();
CREATE FUNCTION sync_namespace_stored(j public.operation_journal) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('status',jsonb_build_object('schema','saturn.namespace-mutation-status.v1','operationId',j.id,'intentHash',j.sync_intent_hash,'state',j.namespace_state)
   ||CASE WHEN j.sync_result IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('result',j.sync_result) END,
   'execution',j.namespace_execution,'claimToken',j.namespace_claim_token)
$$;
CREATE FUNCTION sync_namespace_authorize(root uuid,kind text,credential jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d public.devices%ROWTYPE; r public.resources%ROWTYPE;
BEGIN
 IF jsonb_typeof(credential)<>'object' OR octet_length(credential::text)>2048 THEN RAISE EXCEPTION 'authority_invalid'; END IF;
 IF credential->>'type'='maintenance' THEN
   IF kind<>'availability' THEN RAISE EXCEPTION 'authority_invalid'; END IF;
   RETURN jsonb_build_object('type','worker','id','integrity-scrub');
 ELSIF credential ? 'deviceId' THEN
   SELECT * INTO d FROM public.devices WHERE id=(credential->>'deviceId')::uuid FOR SHARE;
   SELECT * INTO r FROM public.resources WHERE id=root;
   IF d.id IS NULL OR d.state<>'active' OR NOT d.can_read OR NOT d.can_write OR d.token_hash IS DISTINCT FROM credential->>'tokenHash'
     OR d.device_kind IS DISTINCT FROM credential->>'deviceKind' OR d.device_kind NOT IN ('windows_sync','pluto')
     OR d.sync_root_id IS DISTINCT FROM root OR d.scope_ids IS DISTINCT FROM ARRAY[root] OR (d.expires_at IS NOT NULL AND d.expires_at<=now())
     OR r.status<>'active' OR r.type<>'folder' THEN RAISE EXCEPTION 'authorization_changed'; END IF;
   IF kind IN ('move','quarantine-delete','restore') AND (d.device_kind='pluto' OR kind='move' AND NOT d.can_move OR kind IN ('quarantine-delete','restore') AND NOT d.can_delete)
     OR kind='availability' THEN RAISE EXCEPTION 'forbidden'; END IF;
   RETURN jsonb_build_object('type','device_token','id',d.id);
 ELSIF credential->>'actorType' IN ('owner_web','owner_bootstrap') THEN
   IF credential->>'rootId' IS DISTINCT FROM root::text THEN RAISE EXCEPTION 'authority_invalid'; END IF;
   IF credential->>'actorType'='owner_web' AND NOT EXISTS(SELECT 1 FROM public.web_sessions WHERE id=(credential->>'sessionId')::uuid
     AND token_hash=credential->>'tokenHash' AND state='active' AND idle_expires_at>now() AND expires_at>now() FOR SHARE) THEN RAISE EXCEPTION 'authorization_changed'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.owner_credentials WHERE owner_id='owner' AND revision::text=credential->>'revision' FOR SHARE) THEN RAISE EXCEPTION 'authorization_changed'; END IF;
   RETURN jsonb_build_object('type',credential->>'actorType','id','owner');
 END IF;
 RAISE EXCEPTION 'authority_invalid';
END $$;
CREATE FUNCTION sync_namespace_command(command text,envelope jsonb,credential jsonb,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_variable
DECLARE i jsonb:=envelope->'input'; policy jsonb:=envelope->'namespace'; g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE;
 p public.sync_root_policy%ROWTYPE; j public.operation_journal%ROWTYPE; r public.resources%ROWTYPE; target public.resources%ROWTYPE; src public.resources%ROWTYPE;
 oldparent public.resources%ROWTYPE; ancestor public.resources%ROWTYPE; actor jsonb; h text; e jsonb; description jsonb; resultj jsonb;
 node uuid; versionid uuid; oldpath text; newpath text; privatepath text; kind text:=i->>'kind'; size bigint:=0; digest text;
 seq bigint; firstseq bigint; oldchain uuid[]:='{}'; newchain uuid[]:='{}'; touched uuid[]:='{}'; cur uuid; hops integer; delta bigint;
 dp public.sync_delete_plans%ROWTYPE;
BEGIN
 IF command NOT IN ('reserve','status','claim','commit','unknown','lookup','approve-delete-plan') OR jsonb_typeof(envelope) IS DISTINCT FROM 'object'
   OR octet_length(envelope::text)>(CASE WHEN command='approve-delete-plan' THEN 131072 ELSE 65536 END) OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR octet_length(payload::text)>4096 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=(i->>'rootId')::uuid;
 IF NOT FOUND OR session_user<>g.writer_login OR current_user<>g.writer_owner OR g.writer_contract<>'folder-file-cas-cj04.v1' THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=g.root_id FOR UPDATE;
 SELECT * INTO p FROM public.sync_root_policy WHERE root_id=g.root_id FOR SHARE;
 IF p.root_id IS NULL THEN RAISE EXCEPTION 'unsupported'; END IF;
 IF command<>'unknown' THEN actor:=public.sync_namespace_authorize(g.root_id,kind,credential); END IF;
 IF command='approve-delete-plan' THEN
   IF p.state<>'ACTIVE' THEN RAISE EXCEPTION 'backend_draining'; END IF;
   IF kind<>'quarantine-delete' OR c.namespace_state<>'ACTIVE' OR NOT public.catalog_guard_active_valid(g)
     OR NOT p.features ? 'namespace-mutations-v1' OR c.epoch::text IS DISTINCT FROM i->>'epoch' OR c.binding_version::text IS DISTINCT FROM i->>'bindingVersion'
     OR policy->>'codec' IS DISTINCT FROM p.codec OR policy->>'policyHash' IS DISTINCT FROM p.policy_hash THEN RAISE EXCEPTION 'binding_invalid'; END IF;
   IF i->>'schema' IS DISTINCT FROM 'saturn.delete-plan.v1' OR i->>'planId' !~ '^[a-f0-9-]{36}$' OR i->>'planDigest' !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(i->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(i->'items') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_input'; END IF;
   SELECT * INTO dp FROM public.sync_delete_plans WHERE id=(i->>'planId')::uuid FOR UPDATE;
   IF FOUND THEN
     IF dp.root_id<>g.root_id OR dp.binding_version<>c.binding_version OR dp.policy_hash<>p.policy_hash OR dp.digest<>i->>'planDigest'
       OR dp.items IS DISTINCT FROM i->'items' OR dp.actor IS DISTINCT FROM actor THEN RAISE EXCEPTION 'operation_reused'; END IF;
   ELSE
     IF (SELECT count(DISTINCT item->>'nodeId') FROM jsonb_array_elements(i->'items') item)<>jsonb_array_length(i->'items') THEN RAISE EXCEPTION 'invalid_input'; END IF;
     PERFORM id FROM public.resources WHERE id IN (SELECT (item->>'nodeId')::uuid FROM jsonb_array_elements(i->'items') item) ORDER BY id FOR SHARE;
     IF EXISTS(SELECT 1 FROM jsonb_array_elements(i->'items') item LEFT JOIN public.resources approved_resource ON approved_resource.id=(item->>'nodeId')::uuid
       WHERE approved_resource.id IS NULL OR approved_resource.id=g.root_id OR approved_resource.status<>'active' OR approved_resource.metadata_version::text IS DISTINCT FROM item->>'version'
         OR public.catalog_guard_scope(approved_resource.id,false) IS DISTINCT FROM ARRAY[g.root_id]) THEN RAISE EXCEPTION 'precondition_failed'; END IF;
     INSERT INTO public.sync_delete_plans(id,root_id,digest,binding_version,policy_hash,items,actor,approved_at)
       VALUES((i->>'planId')::uuid,g.root_id,i->>'planDigest',c.binding_version,p.policy_hash,i->'items',actor,now()) RETURNING * INTO dp;
   END IF;
   RETURN jsonb_build_object('schema','saturn.delete-plan-approved.v1','planId',dp.id,'planDigest',dp.digest,'itemCount',jsonb_array_length(dp.items));
 END IF;
 IF command='lookup' THEN
   IF p.state<>'ACTIVE' THEN RAISE EXCEPTION 'backend_draining'; END IF;
   IF NOT p.features ? 'clone-content-v1' OR c.epoch::text IS DISTINCT FROM i->>'epoch' OR c.binding_version::text IS DISTINCT FROM i->>'bindingVersion' THEN RAISE EXCEPTION 'binding_invalid'; END IF;
   SELECT * INTO src FROM public.resources WHERE sha256=i->>'sha256' AND size_bytes=(i->>'sizeBytes')::bigint AND type='file' AND status='active' AND sync_availability='AVAILABLE'
     AND public.catalog_guard_scope(id,false)=ARRAY[g.root_id] ORDER BY id LIMIT 1;
   RETURN jsonb_build_object('reference',CASE WHEN src.id IS NULL THEN NULL ELSE jsonb_build_object('nodeId',src.id,'contentVersionId',src.current_version_id,'metadataVersion',src.metadata_version,'sizeBytes',src.size_bytes::text,'sha256',src.sha256) END);
 END IF;
 IF i->>'schema' IS DISTINCT FROM 'saturn.namespace-mutation.v1' OR kind NOT IN ('move','quarantine-delete','restore','metadata-patch','create-empty','clone-content','availability')
   OR i->>'idempotencyKey' !~ '^[A-Za-z0-9._:-]{8,128}$' OR i->>'operationId' !~ '^[a-f0-9-]{36}$' THEN RAISE EXCEPTION 'invalid_input'; END IF;
 h:=encode(sha256(convert_to(envelope::text,'UTF8')),'hex');
 SELECT * INTO j FROM public.operation_journal WHERE id=(i->>'operationId')::uuid OR idempotency_key='namespace:'||(i->>'idempotencyKey') ORDER BY id LIMIT 1 FOR UPDATE;
 IF j.id IS NOT NULL THEN
   IF j.id::text IS DISTINCT FROM i->>'operationId' OR j.idempotency_key IS DISTINCT FROM 'namespace:'||(i->>'idempotencyKey') OR j.namespace_intent IS DISTINCT FROM envelope
     OR j.sync_intent_hash IS DISTINCT FROM h OR j.payload->'actor' IS DISTINCT FROM actor AND command<>'unknown' THEN RAISE EXCEPTION 'operation_reused'; END IF;
   IF command='status' OR j.namespace_state='PUBLISHED' THEN RETURN public.sync_namespace_stored(j); END IF;
 ELSIF command<>'reserve' THEN RAISE EXCEPTION 'operation_reused'; END IF;
 IF command='unknown' THEN
   IF j.namespace_claim_token::text IS DISTINCT FROM payload->>'claimToken' OR j.namespace_state NOT IN ('PHYSICAL_PENDING','UNKNOWN') THEN RAISE EXCEPTION 'operation_reused'; END IF;
   UPDATE public.operation_journal SET namespace_state='UNKNOWN',error_code='reconciliation_required',updated_at=now() WHERE id=j.id RETURNING * INTO j;
   UPDATE public.sync_root_clock SET namespace_state='BACKEND_UNCERTAIN',updated_at=now() WHERE root_id=g.root_id;
   RETURN public.sync_namespace_stored(j);
 END IF;
 IF p.state<>'ACTIVE' AND NOT(p.state='PAUSED' AND j.id IS NOT NULL) THEN RAISE EXCEPTION 'backend_draining'; END IF;
 IF c.namespace_state<>'ACTIVE' OR NOT public.catalog_guard_active_valid(g) OR NOT p.features ? 'namespace-mutations-v1'
   OR c.epoch::text IS DISTINCT FROM i->>'epoch' OR c.binding_version::text IS DISTINCT FROM i->>'bindingVersion' THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 IF policy->>'codec' IS DISTINCT FROM p.codec THEN RAISE EXCEPTION 'codec_mismatch'; END IF;
 IF policy->>'policyHash' IS DISTINCT FROM p.policy_hash THEN RAISE EXCEPTION 'policy_mismatch'; END IF;
 IF kind='clone-content' AND NOT p.features ? 'clone-content-v1' THEN RAISE EXCEPTION 'unsupported'; END IF;
 IF EXISTS(SELECT 1 FROM public.operation_journal WHERE sync_root_id=g.root_id AND sync_result IS NULL AND id<>(i->>'operationId')::uuid
   AND NOT public.catalog_upload_transport(operation_journal)) THEN RAISE EXCEPTION 'reconciliation_required'; END IF;
 IF i->'expected'->>'kind'='version' THEN
   SELECT * INTO r FROM public.resources WHERE id=(i->'expected'->>'node_id')::uuid FOR UPDATE;
   IF r.id IS NULL OR r.id=g.root_id OR r.metadata_version::text IS DISTINCT FROM i->'expected'->>'version'
     OR public.catalog_guard_scope(r.id,false) IS DISTINCT FROM ARRAY[g.root_id]
     OR (kind='restore' AND r.status<>'trashed') OR (kind<>'restore' AND r.status<>'active') THEN RAISE EXCEPTION 'precondition_failed'; END IF;
   node:=r.id; size:=r.size_bytes; digest:=r.sha256; versionid:=r.current_version_id; oldpath:=r.storage_path;
 ELSE
   IF i->'expected' IS DISTINCT FROM '{"kind":"absent"}'::jsonb OR kind NOT IN ('create-empty','clone-content') THEN RAISE EXCEPTION 'invalid_input'; END IF;
   node:=coalesce((j.namespace_execution->>'nodeId')::uuid,gen_random_uuid()); versionid:=coalesce((j.namespace_execution->>'versionId')::uuid,gen_random_uuid());
 END IF;
 IF kind IN ('create-empty','clone-content') AND r.id IS NOT NULL THEN RAISE EXCEPTION 'unsupported'; END IF;
 IF kind IN ('move','restore','create-empty','clone-content') THEN
   SELECT * INTO target FROM public.resources WHERE id=(i->>'parentId')::uuid FOR UPDATE;
   IF target.id IS NULL OR target.type<>'folder' OR target.status<>'active' OR public.catalog_guard_scope(target.id,false) IS DISTINCT FROM ARRAY[g.root_id]
     OR target.id=node OR target.storage_path LIKE oldpath||'/%' THEN RAISE EXCEPTION 'membership_changed'; END IF;
   IF length(i->>'name') NOT BETWEEN 1 AND 255 OR octet_length(i->>'name')>1020 OR i->>'name' IN ('.','..') OR i->>'name' ~ '[/\\]|[[:cntrl:]]' THEN RAISE EXCEPTION 'invalid_input'; END IF;
   IF p.codec='portable_v1' AND (i->>'name'<>normalize(i->>'name',NFC) OR i->>'name' ~ '[<>:"|?*]|[. ]$' OR i->>'name' ~* '^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)') THEN RAISE EXCEPTION 'invalid_name'; END IF;
   IF EXISTS(SELECT 1 FROM public.resources WHERE parent_id=target.id AND lower(name)=lower(i->>'name') AND status NOT IN ('trashed','purged') AND id<>node) THEN RAISE EXCEPTION 'precondition_failed'; END IF;
   newpath:=target.storage_path||'/'||(i->>'name');
 END IF;
 IF kind='clone-content' THEN
   SELECT * INTO src FROM public.resources WHERE id=(i->'source'->>'nodeId')::uuid FOR SHARE;
   IF src.id IS NULL OR src.status<>'active' OR src.type<>'file' OR src.sync_availability<>'AVAILABLE' OR public.catalog_guard_scope(src.id,false) IS DISTINCT FROM ARRAY[g.root_id]
     OR src.current_version_id::text IS DISTINCT FROM i->'source'->>'contentVersionId' OR src.metadata_version::text IS DISTINCT FROM i->'source'->>'metadataVersion'
     OR src.sha256 IS DISTINCT FROM i->'source'->>'sha256' OR src.size_bytes::text IS DISTINCT FROM i->'source'->>'sizeBytes' THEN RAISE EXCEPTION 'precondition_failed'; END IF;
   size:=src.size_bytes; digest:=src.sha256;
 ELSIF kind='create-empty' THEN size:=0;digest:='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
 ELSIF kind='metadata-patch' THEN
   IF r.type<>'file' OR r.sync_availability<>'AVAILABLE' OR r.current_version_id::text IS DISTINCT FROM i->>'contentVersionId' OR r.sha256 IS DISTINCT FROM i->>'sha256' THEN RAISE EXCEPTION 'precondition_failed'; END IF;
 ELSIF kind='availability' THEN
   IF NOT EXISTS(SELECT 1 FROM public.file_versions v WHERE v.id=(i->>'contentVersionId')::uuid AND v.resource_id=r.id AND v.sha256=i->>'sha256' AND v.state='active' FOR UPDATE)
     OR i->>'reason' IS DISTINCT FROM 'integrity_scrub' OR i->>'availability' NOT IN ('UNAVAILABLE','UNKNOWN') THEN RAISE EXCEPTION 'precondition_failed'; END IF;
   versionid:=(i->>'contentVersionId')::uuid;
 ELSIF kind='quarantine-delete' THEN
   IF EXISTS(SELECT 1 FROM public.resources WHERE parent_id=r.id AND status NOT IN ('trashed','purged')) THEN RAISE EXCEPTION 'directory_not_empty'; END IF;
   IF i->>'planId' IS NULL OR i->>'planDigest' IS NULL OR NOT EXISTS(SELECT 1 FROM public.sync_delete_plans approved_plan WHERE approved_plan.id=(i->>'planId')::uuid AND approved_plan.root_id=g.root_id
     AND approved_plan.digest=i->>'planDigest' AND approved_plan.binding_version=c.binding_version AND approved_plan.policy_hash=p.policy_hash AND approved_plan.actor=actor AND approved_plan.approved_at IS NOT NULL
     AND approved_plan.items @> jsonb_build_array(jsonb_build_object('nodeId',r.id,'version',r.metadata_version))) THEN RAISE EXCEPTION 'approval_stale'; END IF;
   newpath:='_system/trash/'||(i->>'operationId')||'/'||r.name;
 ELSIF kind='restore' THEN
   IF NOT EXISTS(SELECT 1 FROM public.operation_journal d WHERE d.id=(i->>'deletedOperationId')::uuid AND d.resource_id=r.id AND d.namespace_state='PUBLISHED'
      AND d.namespace_intent->'input'->>'kind'='quarantine-delete') THEN RAISE EXCEPTION 'precondition_failed'; END IF;
 END IF;
 privatepath:='_system/incoming/'||(i->>'operationId')||'.namespace';
 IF octet_length(newpath)>4096 OR kind IN ('move','restore') AND EXISTS(SELECT 1 FROM public.resources
   WHERE starts_with(storage_path,oldpath||'/') AND octet_length(newpath||substring(storage_path FROM length(oldpath)+1))>4096) THEN RAISE EXCEPTION 'invalid_input'; END IF;
 IF size>coalesce((g.active_runtime->>'maximumFileBytes')::bigint,1073741824) AND kind IN ('clone-content','create-empty') THEN RAISE EXCEPTION 'upload_too_large'; END IF;
 -- Complete lock set is obtained before physical claim; all commands lock the
 -- root clock first and never hold a partial physical guard while waiting.
 cur:=CASE WHEN kind='restore' THEN NULL ELSE r.parent_id END;hops:=0;
 WHILE cur IS NOT NULL LOOP
   IF cur=ANY(oldchain) OR hops>130 THEN RAISE EXCEPTION 'membership_changed'; END IF;
   oldchain:=array_append(oldchain,cur);SELECT parent_id INTO cur FROM public.resources WHERE id=cur;hops:=hops+1;
 END LOOP;
 cur:=target.id;hops:=0;
 WHILE cur IS NOT NULL LOOP
   IF cur=ANY(newchain) OR hops>130 THEN RAISE EXCEPTION 'membership_changed'; END IF;
   newchain:=array_append(newchain,cur);SELECT parent_id INTO cur FROM public.resources WHERE id=cur;hops:=hops+1;
 END LOOP;
 PERFORM id FROM public.resources WHERE id=ANY(oldchain||newchain) ORDER BY id FOR NO KEY UPDATE;
 IF j.id IS NULL THEN
   e:=jsonb_build_object('nodeId',node,'versionId',versionid,'before',CASE WHEN r.id IS NULL THEN NULL ELSE public.catalog_namespace_description(r,g.root_id) END,
     'sourcePath',CASE WHEN kind='clone-content' THEN src.storage_path ELSE oldpath END,'targetPath',newpath,'tempPath',privatepath,'sizeBytes',size::text,'sha256',digest,
     'sourceContentVersionId',src.current_version_id,'oldAncestors',to_jsonb(oldchain),'newAncestors',to_jsonb(newchain));
   INSERT INTO public.operation_journal(id,operation_type,state,idempotency_key,payload,sync_root_id,sync_epoch,sync_intent_hash,namespace_intent,namespace_execution,namespace_state)
     VALUES((i->>'operationId')::uuid,'namespace_mutation','created','namespace:'||(i->>'idempotencyKey'),jsonb_build_object('actor',actor),g.root_id,c.epoch,h,envelope,e,'PREPARED') RETURNING * INTO j;
 ELSIF j.namespace_execution->>'sourcePath' IS DISTINCT FROM (CASE WHEN kind='clone-content' THEN src.storage_path ELSE oldpath END)
   OR j.namespace_execution->>'targetPath' IS DISTINCT FROM newpath THEN RAISE EXCEPTION 'membership_changed'; END IF;
 IF command='reserve' THEN RETURN public.sync_namespace_stored(j); END IF;
 IF command='claim' THEN
   IF j.namespace_state<>'PREPARED' THEN RAISE EXCEPTION 'operation_unknown'; END IF;
   UPDATE public.operation_journal SET namespace_state='PHYSICAL_PENDING',namespace_claim_token=(payload->>'claimToken')::uuid,state='committing',updated_at=now() WHERE id=j.id RETURNING * INTO j;
   RETURN public.sync_namespace_stored(j);
 END IF;
 IF command<>'commit' OR j.namespace_state<>'PHYSICAL_PENDING' OR j.namespace_claim_token::text IS DISTINCT FROM payload->>'claimToken' THEN RAISE EXCEPTION 'operation_unknown'; END IF;
 firstseq:=c.published_seq+1;seq:=c.published_seq;
 IF seq>9223372036854775807-300 THEN RAISE EXCEPTION 'counter_exhausted'; END IF;
 IF kind IN ('create-empty','clone-content') THEN
   INSERT INTO public.resources(id,type,parent_id,name,storage_path,mime_type,size_bytes,sha256,current_version_id,status,sync_availability)
     VALUES(node,'file',target.id,i->>'name',newpath,'application/octet-stream',size,digest,versionid,'active','AVAILABLE');
   INSERT INTO public.file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason,state)
     VALUES(versionid,node,newpath,digest,size,'application/octet-stream','initial','active');
 ELSIF kind IN ('move','restore','quarantine-delete') THEN
   -- One physical directory rename; descendants retain stable IDs and content.
   UPDATE public.file_versions SET storage_path=newpath||substring(storage_path FROM length(oldpath)+1)
     WHERE storage_path=oldpath OR starts_with(storage_path,oldpath||'/');
   UPDATE public.resources SET storage_path=newpath||substring(storage_path FROM length(oldpath)+1)
     WHERE id<>node AND starts_with(storage_path,oldpath||'/');
   UPDATE public.resources SET parent_id=CASE WHEN kind='quarantine-delete' THEN parent_id ELSE target.id END,
     name=CASE WHEN kind='quarantine-delete' THEN name ELSE i->>'name' END,storage_path=newpath,
     status=CASE WHEN kind='quarantine-delete' THEN 'trashed' ELSE 'active' END,
     trashed_from_parent_id=CASE WHEN kind='quarantine-delete' THEN parent_id ELSE NULL END,
     trashed_from_name=CASE WHEN kind='quarantine-delete' THEN name ELSE NULL END,
     purge_after=CASE WHEN kind='quarantine-delete' THEN now()+interval '30 days' ELSE NULL END,updated_at=now() WHERE id=node;
   UPDATE public.resources SET sync_availability=coalesce(j.namespace_execution->'before'->>'availability','UNKNOWN') WHERE id=node;
 ELSIF kind='metadata-patch' THEN
   UPDATE public.resources SET source_modified_at=(i->>'modifiedAt')::timestamptz,updated_at=now() WHERE id=node;
 ELSIF kind='availability' THEN
   UPDATE public.resources SET sync_availability=i->>'availability',updated_at=now() WHERE id=node AND current_version_id=versionid;
   UPDATE public.file_versions SET state='error' WHERE id=versionid AND state='active';
 END IF;
 IF kind IN ('move','restore','quarantine-delete','create-empty','clone-content') AND size<>0 THEN
   FOR ancestor IN SELECT * FROM public.resources WHERE id=ANY(oldchain||newchain) ORDER BY id LOOP
     delta:=(CASE WHEN ancestor.id=ANY(newchain) THEN size ELSE 0 END)-(CASE WHEN ancestor.id=ANY(oldchain) THEN size ELSE 0 END);
     IF delta<>0 THEN UPDATE public.resources SET size_bytes=size_bytes+delta,updated_at=now() WHERE id=ancestor.id;touched:=array_append(touched,ancestor.id); END IF;
   END LOOP;
 END IF;
 SELECT * INTO r FROM public.resources WHERE id=node;
 description:=public.catalog_namespace_description(r,g.root_id);seq:=seq+1;
 INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document) VALUES(g.root_id,c.epoch,seq,node,j.id,
   jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',node,'kind',CASE WHEN kind='quarantine-delete' THEN 'tombstone' ELSE 'upsert' END,
     'description',description,'reason','namespace.'||kind,'actor',actor)||CASE WHEN kind='quarantine-delete' THEN jsonb_build_object('before_version',i->'expected'->>'version') ELSE '{}'::jsonb END);
 FOR ancestor IN SELECT * FROM public.resources WHERE id=ANY(touched) AND g.root_id=ANY(public.catalog_guard_scope(id,false)) ORDER BY id LOOP
   seq:=seq+1;INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document) VALUES(g.root_id,c.epoch,seq,ancestor.id,j.id,
     jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',ancestor.id,'kind','upsert','description',public.catalog_namespace_description(ancestor,g.root_id),'reason','namespace.ancestor','actor',actor));
 END LOOP;
 resultj:=jsonb_build_object('description',description,'firstSeq',firstseq::text,'lastSeq',seq::text,'tombstone',kind='quarantine-delete');
 UPDATE public.operation_journal SET namespace_state='PUBLISHED',state='active',resource_id=node,sync_first_seq=firstseq,sync_last_seq=seq,sync_result=resultj,updated_at=now() WHERE id=j.id RETURNING * INTO j;
 UPDATE public.sync_root_clock SET published_seq=seq,updated_at=now() WHERE root_id=g.root_id;
 RETURN public.sync_namespace_stored(j);
END $$;
ALTER TABLE resources ADD COLUMN source_modified_at timestamptz;
CREATE OR REPLACE FUNCTION renew_resource_metadata_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE guarded_move boolean:=false;
BEGIN
 IF TG_OP='UPDATE' THEN
   guarded_move:=NEW.type=OLD.type AND NEW.sha256 IS NOT DISTINCT FROM OLD.sha256 AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
     AND EXISTS(SELECT 1 FROM public.catalog_guard_roots g JOIN public.operation_journal j ON j.sync_root_id=g.root_id
       WHERE current_user=g.writer_owner AND session_user=g.writer_login AND j.namespace_state='PHYSICAL_PENDING'
         AND j.namespace_intent->'input'->>'kind' IN ('move','restore','quarantine-delete')
         AND (OLD.id::text=j.namespace_execution->>'nodeId' OR starts_with(OLD.storage_path,(j.namespace_execution->>'sourcePath')||'/')));
   IF OLD.sync_availability='AVAILABLE' AND NEW.sync_availability='AVAILABLE' AND NOT guarded_move
     AND (NEW.storage_path IS DISTINCT FROM OLD.storage_path OR ROW(NEW.parent_id,NEW.name,NEW.type,NEW.size_bytes,NEW.sha256,NEW.current_version_id,NEW.status)
       IS DISTINCT FROM ROW(OLD.parent_id,OLD.name,OLD.type,OLD.size_bytes,OLD.sha256,OLD.current_version_id,OLD.status)) THEN
     IF OLD.type='folder' AND NEW.type='folder' AND (to_jsonb(OLD)-ARRAY['size_bytes','updated_at','metadata_version'])=(to_jsonb(NEW)-ARRAY['size_bytes','updated_at','metadata_version'])
       AND EXISTS(SELECT 1 FROM public.catalog_guard_roots g JOIN public.sync_root_clock c ON c.root_id=g.root_id WHERE c.namespace_state IN ('QUALIFYING','ACTIVE')
         AND (g.root_id=ANY(public.catalog_guard_scope(OLD.id,false)) AND current_user=g.writer_owner AND session_user=g.writer_login
           OR OLD.id=ANY(g.control_ancestor_ids) AND current_user=session_user AND session_user=g.runtime_role)) THEN NULL;
     ELSE NEW.sync_availability:='UNKNOWN'; END IF;
   END IF;
 END IF;
 IF TG_OP='INSERT' THEN NEW.metadata_version:=gen_random_uuid();
 ELSIF ROW(NEW.parent_id,NEW.name,NEW.type,NEW.size_bytes,NEW.sha256,NEW.current_version_id,NEW.status,NEW.source_modified_at,coalesce(NEW.sync_availability,'UNKNOWN'))
   IS DISTINCT FROM ROW(OLD.parent_id,OLD.name,OLD.type,OLD.size_bytes,OLD.sha256,OLD.current_version_id,OLD.status,OLD.source_modified_at,coalesce(OLD.sync_availability,'UNKNOWN')) THEN NEW.metadata_version:=gen_random_uuid();
 ELSIF OLD.metadata_version IS NOT NULL THEN NEW.metadata_version:=OLD.metadata_version;
 ELSIF NEW.metadata_version IS NOT NULL THEN NEW.metadata_version:=gen_random_uuid(); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sync_namespace_command(text,jsonb,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_namespace_authorize(uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON sync_root_policy,sync_delete_plans FROM PUBLIC;
