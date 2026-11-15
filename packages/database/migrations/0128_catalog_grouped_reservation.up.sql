-- A fresh, homogeneous reserve-small set may share the locked topology.
-- Existing mixed, replay and ineligible sets keep the original batch path.
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.pg_advisory_xact_lock(1397967206);
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sync_backend_executor WHERE state <> 'STOPPED') THEN
    RAISE EXCEPTION 'backend must be stopped before grouped reservation migration';
  END IF;
END
$guard$;

CREATE FUNCTION public.catalog_upload_try_reserve_set_v1(credential jsonb, requests jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  item jsonb;
  plans jsonb := '[]'::jsonb;
  results jsonb;
  root_text text;
  parent_text text;
  item_count integer;
  g public.catalog_guard_roots%ROWTYPE;
  c public.sync_root_clock%ROWTYPE;
  d public.devices%ROWTYPE;
  p public.resources%ROWTYPE;
  input jsonb;
  request_payload jsonb;
  intent jsonb;
  execution jsonb;
  intent_hash text;
  target_root uuid;
  target_parent uuid;
  expected_root_parent uuid;
  cur uuid;
  upload uuid;
  node uuid;
  version uuid;
  transfer_token uuid;
  target text;
  pending bigint;
  blocked boolean;
  chain uuid[] := '{}';
  inroot uuid[] := '{}';
  topology jsonb := '[]';
  paths jsonb := '[]';
  root_depth integer := -1;
  depth integer := 0;
  uuid_pattern constant text := '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
BEGIN
  IF jsonb_typeof(requests) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  item_count := jsonb_array_length(requests);
  IF item_count NOT BETWEEN 2 AND 4 OR octet_length(requests::text) > 524288 THEN RETURN NULL; END IF;
  root_text := requests->0->'input'->'intent'->>'rootId';
  parent_text := requests->0->'input'->'intent'->>'parentId';
  IF root_text IS NULL OR parent_text IS NULL OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(requests) AS r(value)
    WHERE CASE WHEN jsonb_typeof(r.value) IS DISTINCT FROM 'object' THEN true ELSE
       r.value - ARRAY['command','input','payload'] <> '{}'::jsonb
       OR NOT r.value ?& ARRAY['command','input','payload']
       OR r.value->>'command' IS DISTINCT FROM 'reserve-small'
       OR r.value->'input'->'intent'->>'rootId' IS DISTINCT FROM root_text
       OR r.value->'input'->'intent'->>'parentId' IS DISTINCT FROM parent_text
       OR r.value->'input'->'intent'->>'schema' IS DISTINCT FROM 'saturn.upload-intent.v2'
       OR r.value->'input'->'intent'->>'requireAbsent' IS DISTINCT FROM 'true'
       OR r.value->'payload' ? 'originalUploadId'
    END
  ) THEN RETURN NULL; END IF;

  -- This path is only for one fresh absent group. Return to the original
  -- batch loop on every refusal, keeping its per-original error and replay.
  BEGIN
    IF root_text !~ uuid_pattern OR parent_text !~ uuid_pattern OR jsonb_typeof(credential) IS DISTINCT FROM 'object'
      OR octet_length(credential::text)>512 THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(credential))<>3 OR NOT credential ?& ARRAY['deviceId','tokenHash','deviceKind']
      OR jsonb_typeof(credential->'deviceId') IS DISTINCT FROM 'string' OR credential->>'deviceId' !~ uuid_pattern
      OR jsonb_typeof(credential->'tokenHash') IS DISTINCT FROM 'string' OR credential->>'tokenHash' !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(credential->'deviceKind') IS DISTINCT FROM 'string'
      OR credential->>'deviceKind' NOT IN ('windows_sync','pluto')
    THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
    IF (SELECT ns.nspname FROM pg_class r JOIN pg_namespace ns ON ns.oid=r.relnamespace WHERE r.oid='public.catalog_guard_roots'::regclass)
      IS DISTINCT FROM 'public' THEN RAISE EXCEPTION 'public namespace required' USING ERRCODE='42501'; END IF;
    target_root:=root_text::uuid;
    target_parent:=parent_text::uuid;
    SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=target_root;
    IF NOT FOUND OR g.writer_contract<>'folder-file-cas-cj04.v1' OR current_user<>g.writer_owner OR session_user<>g.writer_login
      THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
    SELECT * INTO c FROM public.sync_root_clock WHERE root_id=target_root FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
    SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=target_root;
    IF NOT FOUND OR g.writer_contract<>'folder-file-cas-cj04.v1' OR current_user<>g.writer_owner OR session_user<>g.writer_login
      OR c.descriptor_schema<>'saturn.current-namespace.v1'
      OR NOT (c.namespace_state='QUALIFYING' OR c.namespace_state='ACTIVE' AND public.catalog_guard_active_valid(g))
      THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
    SELECT * INTO d FROM public.devices WHERE id=(credential->>'deviceId')::uuid FOR SHARE;
    expected_root_parent:=CASE WHEN d.device_kind='windows_sync' THEN '00000000-0000-7000-8000-000000000004'::uuid
      ELSE '00000000-0000-7000-8000-000000000009'::uuid END;
    SELECT * INTO p FROM public.resources WHERE id=target_root;
    IF NOT FOUND OR d.id IS NULL OR d.state<>'active' OR NOT d.can_write
      OR d.token_hash IS DISTINCT FROM credential->>'tokenHash' OR d.device_kind IS DISTINCT FROM credential->>'deviceKind'
      OR d.sync_root_id IS DISTINCT FROM target_root OR d.scope_ids IS DISTINCT FROM ARRAY[target_root]
      OR (d.expires_at IS NOT NULL AND d.expires_at<=now()) OR p.status<>'active' OR p.type<>'folder'
      OR p.parent_id IS DISTINCT FROM expected_root_parent
      THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
    SELECT count(*),coalesce(bool_or(NOT coalesce(j.upload_execution IS NOT NULL AND j.upload_effect_state IN ('transport','verified'),false)),false)
      INTO pending,blocked FROM public.operation_journal j WHERE j.sync_root_id=target_root AND j.sync_result IS NULL;
    IF blocked OR pending+item_count>4 THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
    cur:=target_parent;
    LOOP
      IF cur=ANY(chain) OR depth>130 THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
      SELECT * INTO p FROM public.resources WHERE id=cur;
      IF NOT FOUND OR p.type<>'folder' OR p.status<>'active' OR (root_depth<0 AND p.metadata_version IS NULL) OR octet_length(p.storage_path)>4096
        THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
      chain:=array_append(chain,cur);
      IF root_depth<0 THEN
        inroot:=array_append(inroot,cur);
        topology:=topology||jsonb_build_array(jsonb_build_object('nodeId',p.id,'parentId',CASE WHEN p.id=target_root THEN NULL ELSE p.parent_id END,'name',p.name));
        paths:=paths||jsonb_build_array(jsonb_build_object('nodeId',p.id,'storagePath',p.storage_path));
      END IF;
      IF cur=target_root THEN root_depth:=depth; END IF;
      IF p.parent_id IS NULL THEN EXIT; END IF;
      cur:=p.parent_id;
      depth:=depth+1;
    END LOOP;
    IF cur<>'00000000-0000-7000-8000-000000000001'::uuid OR root_depth<0 OR root_depth>=128
      THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
    PERFORM id FROM public.resources WHERE id=ANY(chain) ORDER BY id FOR NO KEY UPDATE;
    IF EXISTS(
      SELECT 1 FROM unnest(chain) WITH ORDINALITY q(id,ord)
      LEFT JOIN public.resources r ON r.id=q.id LEFT JOIN public.sync_root_clock nested ON nested.root_id=q.id AND q.id<>target_root
      WHERE r.id IS NULL OR r.parent_id IS DISTINCT FROM chain[q.ord::integer+1] OR r.type<>'folder' OR r.status<>'active'
        OR (q.id=target_root AND r.parent_id IS DISTINCT FROM expected_root_parent)
        OR (q.ord<=cardinality(inroot) AND r.metadata_version IS NULL) OR octet_length(r.storage_path)>4096 OR nested.root_id IS NOT NULL
    ) OR EXISTS(
      SELECT 1 FROM unnest(inroot) WITH ORDINALITY q(id,ord) JOIN public.resources r ON r.id=q.id
      WHERE topology->(q.ord::integer-1) IS DISTINCT FROM jsonb_build_object('nodeId',r.id,'parentId',CASE WHEN r.id=target_root THEN NULL ELSE r.parent_id END,'name',r.name)
        OR paths->(q.ord::integer-1) IS DISTINCT FROM jsonb_build_object('nodeId',r.id,'storagePath',r.storage_path)
    ) THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
    SELECT * INTO p FROM public.resources WHERE id=target_parent;

    FOR item IN SELECT r.value FROM jsonb_array_elements(requests) WITH ORDINALITY r(value,ord) ORDER BY r.ord LOOP
      input:=item->'input';
      request_payload:=item->'payload';
      intent:=input->'intent';
      IF jsonb_typeof(input) IS DISTINCT FROM 'object' OR octet_length(input::text)>69632
        OR jsonb_typeof(request_payload) IS DISTINCT FROM 'object'
        OR jsonb_typeof(request_payload->'transferToken') IS DISTINCT FROM 'string' OR request_payload->>'transferToken' !~ uuid_pattern
        OR jsonb_typeof(intent->'sizeBytes') IS DISTINCT FROM 'string' OR intent->>'sizeBytes' !~ '^[1-9][0-9]{0,5}$'
        THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(input))<>4 OR NOT input ?& ARRAY['epoch','bindingVersion','backendIdentity','intent']
        OR jsonb_typeof(input->'epoch') IS DISTINCT FROM 'string' OR input->>'epoch' !~ uuid_pattern
        OR jsonb_typeof(input->'bindingVersion') IS DISTINCT FROM 'string' OR input->>'bindingVersion' !~ uuid_pattern
        OR jsonb_typeof(input->'backendIdentity') IS DISTINCT FROM 'string' OR input->>'backendIdentity' !~ '^[A-Za-z0-9._:-]{1,128}$'
        OR (intent->>'sizeBytes')::numeric>262144 OR public.catalog_upload_intent_valid(intent) IS DISTINCT FROM true
        OR credential->>'deviceId' IS DISTINCT FROM intent->>'deviceId' OR credential->>'deviceKind' IS DISTINCT FROM intent->>'deviceKind'
        OR g.backend_identity IS DISTINCT FROM input->>'backendIdentity' OR c.epoch::text IS DISTINCT FROM input->>'epoch'
        OR c.binding_version::text IS DISTINCT FROM input->>'bindingVersion' OR topology IS DISTINCT FROM intent->'parentTopology'
        THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
      transfer_token:=(request_payload->>'transferToken')::uuid;
      request_payload:=request_payload-'transferToken';
      IF octet_length(request_payload::text)>2048 OR NOT request_payload ?& ARRAY['uploadId','nodeId','versionId']
        OR (SELECT count(*) FROM jsonb_object_keys(request_payload))<>(3+CASE WHEN request_payload ? 'maximumFileBytes' THEN 1 ELSE 0 END)
        OR EXISTS(SELECT 1 FROM jsonb_each(request_payload) x WHERE x.key<>'maximumFileBytes' AND (jsonb_typeof(x.value) IS DISTINCT FROM 'string' OR x.value#>>'{}' !~ uuid_pattern))
        THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
      IF request_payload ? 'maximumFileBytes' THEN
        IF jsonb_typeof(request_payload->'maximumFileBytes') IS DISTINCT FROM 'string' OR request_payload->>'maximumFileBytes' !~ '^[1-9][0-9]{0,15}$'
          THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
        IF (request_payload->>'maximumFileBytes')::numeric>9007199254740991
          OR (intent->>'sizeBytes')::numeric>(request_payload->>'maximumFileBytes')::numeric
          THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
      END IF;
      IF c.namespace_state='ACTIVE' AND (NOT request_payload ? 'maximumFileBytes'
        OR (intent->>'sizeBytes')::numeric>(g.active_runtime->>'maximumFileBytes')::numeric)
        THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
      upload:=(request_payload->>'uploadId')::uuid;
      node:=(request_payload->>'nodeId')::uuid;
      version:=(request_payload->>'versionId')::uuid;
      target:=rtrim(p.storage_path,'/')||'/'||(intent->>'name');
      IF upload IS NULL OR node IS NULL OR version IS NULL OR upload=node OR upload=version OR node=version OR octet_length(target)>4096
        THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;
      intent_hash:=public.catalog_upload_hash(intent);
      execution:=jsonb_build_object('schema','saturn.catalog-upload-execution.v1','epoch',c.epoch,'bindingVersion',c.binding_version,
        'guardRevision',g.guard_revision,'backendIdentity',g.backend_identity,'nodeId',node,'versionId',version,
        'tempPath','_system/incoming/'||upload::text||'.part','targetPath',target,'archivePath',NULL,'before',NULL,'pathTopology',paths);
      plans:=plans||jsonb_build_array(jsonb_build_object(
        'session',jsonb_build_object('id',upload,'idempotency_key',intent->>'idempotencyKey','parent_id',p.id,'filename',intent->>'name',
          'temp_path',execution->>'tempPath','target_path',target,'expected_size',(intent->>'sizeBytes')::bigint,'expected_sha256',intent->>'sha256',
          'status','uploading','expires_at',now()+interval '24 hours','overwrite_resource_id',NULL,'expected_version_id',NULL,
          'require_absent',true,'audit_actor_type','device_token','audit_actor_id',intent->>'deviceId'),
        'journal',jsonb_build_object('id',upload,'operation_type','upload','state','created','idempotency_key',intent->>'idempotencyKey',
          'upload_id',upload,'payload',jsonb_build_object('parentId',p.id,'filename',intent->>'name'),'upload_intent',intent,'upload_intent_hash',intent_hash,
          'sync_root_id',target_root,'sync_epoch',c.epoch,'sync_intent_hash',intent_hash,'upload_execution',execution,'upload_effect_state','transport',
          'upload_transfer',jsonb_build_object('token',transfer_token,'offset','0','length',intent->>'sizeBytes','originalUploadId',upload),
          'upload_transfer_backend_task',transfer_token)));
    END LOOP;

    IF (SELECT count(DISTINCT x.value->'session'->>'idempotency_key') FROM jsonb_array_elements(plans) x(value))<>item_count
      OR (SELECT count(DISTINCT lower(x.value->'session'->>'filename')) FROM jsonb_array_elements(plans) x(value))<>item_count
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(plans) x(value) JOIN public.operation_journal j ON j.idempotency_key=x.value->'session'->>'idempotency_key')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(plans) x(value) JOIN public.resources r
        ON r.parent_id=target_parent AND lower(r.name)=lower(x.value->'session'->>'filename') AND r.status<>'trashed')
    THEN RAISE EXCEPTION 'reserve_set_ineligible' USING ERRCODE='P7601'; END IF;

    INSERT INTO public.upload_sessions(id,idempotency_key,parent_id,filename,temp_path,target_path,expected_size,expected_sha256,status,expires_at,overwrite_resource_id,expected_version_id,require_absent,audit_actor_type,audit_actor_id)
    SELECT s.id,s.idempotency_key,s.parent_id,s.filename,s.temp_path,s.target_path,s.expected_size,s.expected_sha256,s.status,s.expires_at,
           s.overwrite_resource_id,s.expected_version_id,s.require_absent,s.audit_actor_type,s.audit_actor_id
    FROM jsonb_array_elements(plans) WITH ORDINALITY AS x(value,ord)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::public.upload_sessions,x.value->'session') AS s ORDER BY x.ord;
    INSERT INTO public.operation_journal(id,operation_type,state,idempotency_key,upload_id,payload,upload_intent,upload_intent_hash,sync_root_id,sync_epoch,sync_intent_hash,upload_execution,upload_effect_state,upload_transfer,upload_transfer_backend_task)
    SELECT j.id,j.operation_type,j.state,j.idempotency_key,j.upload_id,j.payload,j.upload_intent,j.upload_intent_hash,j.sync_root_id,j.sync_epoch,j.sync_intent_hash,j.upload_execution,j.upload_effect_state,j.upload_transfer,j.upload_transfer_backend_task
    FROM jsonb_array_elements(plans) WITH ORDINALITY AS x(value,ord)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::public.operation_journal,x.value->'journal') AS j ORDER BY x.ord;

    SELECT jsonb_agg(jsonb_build_object('value',jsonb_build_object('current',jsonb_build_object(
      'execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object(
        'uploadId',j.id,'operationId',j.id,'rootId',j.sync_root_id,'intentHash',j.upload_intent_hash,
        'expectedSizeBytes',u.expected_size::text,'receivedSizeBytes',u.received_size::text,
        'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),
      'result',j.sync_result,'replayed',false),'transfer',j.upload_transfer)) ORDER BY x.ord) INTO results
    FROM jsonb_array_elements(plans) WITH ORDINALITY AS x(value,ord)
    JOIN public.operation_journal j ON j.id=(x.value->'journal'->>'id')::uuid
    JOIN public.upload_sessions u ON u.id=j.id;
    IF jsonb_array_length(results) IS DISTINCT FROM item_count THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
    RETURN results;
  EXCEPTION WHEN SQLSTATE 'P7601' OR unique_violation OR foreign_key_violation OR check_violation THEN
    RETURN NULL;
  WHEN OTHERS THEN
    IF SQLERRM NOT IN ('invalid_input','binding_invalid','authorization_changed','operation_reused','membership_changed','precondition_failed','reconciliation_required','admission_full','transfer_unresolved','verification_failed','projection_mismatch','counter_exhausted','upload_too_large','invalid_name','backend_draining','capacity') THEN RAISE; END IF;
    RETURN NULL;
  END;
END;
$function$;
REVOKE ALL ON FUNCTION public.catalog_upload_try_reserve_set_v1(jsonb,jsonb) FROM PUBLIC;

DO $migration$
DECLARE
  target regprocedure := 'public.catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure;
  helper regprocedure := 'public.catalog_upload_try_reserve_set_v1(jsonb,jsonb)'::regprocedure;
  previous_search_path text := pg_catalog.current_setting('search_path');
  original text;
  definer_owner oid;
  helper_owner oid;
  revised text;
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  original := pg_get_functiondef(target);
  IF encode(sha256(convert_to(replace(original,E'\r\n',E'\n'),'UTF8')),'hex') <> '588bd2f5a26812179b9c5a81b7bae94044bcc2e276ee314b2f4092b76df7a239' THEN
    RAISE EXCEPTION 'unexpected catalog command before migration 128';
  END IF;
  SELECT proowner INTO STRICT definer_owner FROM pg_proc WHERE oid=target AND prosecdef;
  SELECT proowner INTO STRICT helper_owner FROM pg_proc WHERE oid=helper AND NOT prosecdef;
  IF helper_owner <> definer_owner THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.catalog_upload_try_reserve_set_v1(jsonb,jsonb) TO %I',pg_get_userbyid(definer_owner));
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=helper AND (a.grantee NOT IN (helper_owner,definer_owner) OR (a.grantee<>helper_owner AND a.is_grantable))
  ) THEN
    RAISE EXCEPTION 'unexpected grouped reservation helper privileges';
  END IF;
  INSERT INTO public.sync_extension_function_backup (revision,identity,definition)
    VALUES (128,'public.catalog_upload_command(text,jsonb,jsonb,jsonb)',original);
  -- A fresh database may transfer command ownership after migrations. Until
  -- its owner receives helper execution, the ordinary batch remains available.
  revised := replace(replace(original,E'\r\n',E'\n'),$prior$   FOR batch_item IN SELECT value FROM jsonb_array_elements(command_payload) LOOP$prior$,
    replace($next$   IF pg_catalog.has_function_privilege('public.catalog_upload_try_reserve_set_v1(jsonb,jsonb)','EXECUTE') THEN
     batch_value:=public.catalog_upload_try_reserve_set_v1(credential,command_payload);
     IF batch_value IS NOT NULL THEN RETURN batch_value; END IF;
   END IF;
   FOR batch_item IN SELECT value FROM jsonb_array_elements(command_payload) LOOP$next$,E'\r\n',E'\n'));
  IF encode(sha256(convert_to(revised,'UTF8')),'hex') <> 'd90027daf805ff3b3eb07d9cb5fe9e3e80e03d7a6c301cc7c224dcee459ff0e4' THEN
    RAISE EXCEPTION 'unexpected grouped reservation replacement for migration 128';
  END IF;
  EXECUTE revised;
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END
$migration$;
