-- Explicit retirement is required; accepted, unresolved and guarded keys must never be forgotten.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM operation_journal WHERE upload_execution IS NOT NULL) OR EXISTS(SELECT 1 FROM catalog_guard_roots WHERE writer_contract='folder-file-cas-cj04.v1') THEN RAISE EXCEPTION 'CJ04 retirement required before downgrade' USING ERRCODE='55000'; END IF;
END $$;
DO $catalog_upload_restore_guard$ BEGIN
 EXECUTE replace($catalog_upload_old$
CREATE OR REPLACE FUNCTION catalog_guard_rows() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE rows jsonb[]:='{}'; row jsonb; ids uuid[]:='{}'; scoped uuid[]:='{}'; id uuid; g public.catalog_guard_roots%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.catalog_guard_roots) THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN rows:=array_append(rows,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN rows:=array_append(rows,to_jsonb(NEW)); END IF;
 FOREACH row IN ARRAY rows LOOP
   IF TG_TABLE_NAME='resources' THEN
     IF TG_OP<>'INSERT' OR row=to_jsonb(OLD) THEN ids:=ids||public.catalog_guard_scope((row->>'id')::uuid); END IF;
     ids:=ids||public.catalog_guard_scope((row->>'parent_id')::uuid,false);
     ids:=ids||public.catalog_guard_scope((row->>'trashed_from_parent_id')::uuid);
   ELSIF TG_TABLE_NAME='file_versions' THEN ids:=ids||public.catalog_guard_scope((row->>'resource_id')::uuid);
   ELSIF TG_TABLE_NAME='upload_sessions' THEN
     ids:=ids||public.catalog_guard_scope((row->>'parent_id')::uuid)||public.catalog_guard_scope((row->>'resource_id')::uuid)||public.catalog_guard_scope((row->>'overwrite_resource_id')::uuid);
   ELSIF TG_TABLE_NAME='operation_journal' THEN
     IF row->>'sync_root_id' IS NOT NULL THEN ids:=array_append(ids,(row->>'sync_root_id')::uuid); END IF;
     ids:=ids||public.catalog_guard_scope((row->>'resource_id')::uuid);
     IF row->>'upload_id' IS NOT NULL THEN
       SELECT scoped||public.catalog_guard_scope(parent_id) INTO scoped FROM public.upload_sessions WHERE id=(row->>'upload_id')::uuid;
       ids:=ids||coalesce(scoped,'{}');
     END IF;
     IF row->'payload'->>'parentId' ~ '^[a-f0-9-]{36}$' THEN ids:=ids||public.catalog_guard_scope((row->'payload'->>'parentId')::uuid); END IF;
   ELSE ids:=array_append(ids,(row->>'root_id')::uuid);
   END IF;
 END LOOP;
 FOR g IN SELECT * FROM public.catalog_guard_roots WHERE root_id=ANY(ids) LOOP
   -- No custom GUC/actor label/SET ROLE permit. Owner is NOLOGIN and caller has no membership.
   IF current_user<>g.writer_owner OR session_user<>g.writer_login THEN
     RAISE EXCEPTION 'catalog writer unqualified' USING ERRCODE='42501';
   END IF;
   IF TG_TABLE_NAME NOT IN ('resources','operation_journal','sync_root_clock','sync_root_changes')
     OR (TG_TABLE_NAME='resources' AND TG_OP<>'INSERT') THEN
     RAISE EXCEPTION 'catalog writer path unsupported' USING ERRCODE='42501';
   END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION catalog_guard_registration() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.resources%ROWTYPE; c public.sync_root_clock%ROWTYPE; canonical uuid; controls uuid[];
BEGIN
 IF TG_TABLE_SCHEMA<>'public' THEN RAISE EXCEPTION 'catalog guard registration requires qualified public namespace' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'catalog guard retirement requires qualified migration' USING ERRCODE='55000'; END IF;
 -- Only the migration/table owner can install, after an offline physical drain.
 IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_guard_roots'::regclass)
   THEN RAISE EXCEPTION 'catalog guard registration is offline only' USING ERRCODE='42501'; END IF;
 LOCK TABLE public.resources,public.operation_journal,public.sync_root_clock,public.sync_root_changes IN SHARE ROW EXCLUSIVE MODE;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN (NEW.runtime_role,NEW.writer_login,NEW.writer_owner)
   AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
   AND rolcanlogin=(rolname<>NEW.writer_owner))<>3
   OR NEW.writer_owner=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.resources'::regclass)
   THEN RAISE EXCEPTION 'catalog guard principals unqualified' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=NEW.root_id FOR UPDATE;
 SELECT * INTO r FROM public.resources WHERE id=NEW.root_id;
 IF NOT FOUND OR r.type<>'folder' OR r.status<>'active' OR c.namespace_state<>'QUALIFYING' OR c.descriptor_schema<>'saturn.current-namespace.v1'
   OR EXISTS(SELECT 1 FROM public.operation_journal WHERE sync_root_id=NEW.root_id AND sync_result IS NULL)
   OR (SELECT count(*) FROM public.catalog_guard_roots)>=16 THEN RAISE EXCEPTION 'catalog guard registration unqualified' USING ERRCODE='55000'; END IF;
 canonical:=r.parent_id;
 IF canonical NOT IN ('00000000-0000-7000-8000-000000000004'::uuid,'00000000-0000-7000-8000-000000000009'::uuid)
   OR NOT EXISTS(SELECT 1 FROM public.resources WHERE id=canonical AND parent_id='00000000-0000-7000-8000-000000000001' AND type='folder' AND status='active')
   OR NOT EXISTS(SELECT 1 FROM public.devices WHERE sync_root_id=NEW.root_id AND state='active' AND can_write
     AND scope_ids=ARRAY[NEW.root_id] AND device_kind=CASE WHEN canonical='00000000-0000-7000-8000-000000000004'::uuid THEN 'windows_sync' ELSE 'pluto' END)
   THEN RAISE EXCEPTION 'catalog guard canonical assignment unqualified' USING ERRCODE='55000'; END IF;
 controls:=ARRAY['00000000-0000-7000-8000-000000000001'::uuid,canonical];
 IF NEW.control_ancestor_ids<>controls THEN RAISE EXCEPTION 'catalog guard controls mismatch' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION catalog_folder_command(command text,i jsonb,credential jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE; j public.operation_journal%ROWTYPE;
 d public.devices%ROWTYPE; parent public.resources%ROWTYPE; child public.resources%ROWTYPE;
 chain uuid[]:='{}'; cur uuid; nextid uuid; n integer:=0; rh integer:=-1; h text; storage text; descj jsonb; resultj jsonb; seq bigint; actor jsonb;
BEGIN
 IF (SELECT n.nspname FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace WHERE r.oid='public.catalog_guard_roots'::regclass) IS DISTINCT FROM 'public'
   THEN RAISE EXCEPTION 'catalog guard command requires qualified public namespace' USING ERRCODE='42501'; END IF;
 IF command IS NULL OR command NOT IN ('reserve','claim','commit','accepted','unknown') OR jsonb_typeof(i) IS DISTINCT FROM 'object' OR octet_length(i::text)>8192
   OR jsonb_typeof(credential) IS DISTINCT FROM 'object' OR octet_length(credential::text)>512 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(credential))<>3 OR NOT credential ?& ARRAY['deviceId','tokenHash','deviceKind']
   OR EXISTS(SELECT 1 FROM jsonb_each(credential) WHERE jsonb_typeof(value)<>'string')
   OR credential->>'deviceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR credential->>'tokenHash' !~ '^[a-f0-9]{64}$' OR credential->>'deviceKind' NOT IN ('windows_sync','pluto')
   THEN RAISE EXCEPTION 'authority_invalid' USING ERRCODE='42501'; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=(i->>'rootId')::uuid;
 IF NOT FOUND OR current_user<>g.writer_owner OR session_user<>g.writer_login OR i->>'backendIdentity'<>g.backend_identity
   THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='42501'; END IF;
 h:=public.catalog_folder_hash(i);actor:=i->'actor';
 IF actor->>'type' IS DISTINCT FROM 'device_token' OR actor->>'id' IS DISTINCT FROM credential->>'deviceId'
   OR NOT public.catalog_folder_shape(jsonb_populate_record(NULL::public.operation_journal,jsonb_build_object(
     'id',i->>'operationId','operation_type','folder_create','state','created','idempotency_key','catalog-folder:'||(i->>'idempotencyKey'),
     'payload','{}'::jsonb,'sync_root_id',i->>'rootId','sync_epoch',i->>'epoch','sync_intent_hash',h,'catalog_intent',i,'catalog_effect_state','prepared')))
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
   IF j.sync_result IS NOT NULL THEN RETURN jsonb_build_object('intent',i,'storagePath',j.payload->>'storagePath','outcome',jsonb_build_object('replayed',true,'result',j.sync_result)); END IF;
 ELSIF command<>'reserve' THEN RAISE EXCEPTION 'operation_reused' USING ERRCODE='55000';
 END IF;
 IF command='accepted' THEN RETURN NULL; END IF;
 IF command='unknown' THEN
   IF j.catalog_effect_state NOT IN ('physical_pending','reconciliation_required') THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   UPDATE public.operation_journal SET catalog_effect_state='reconciliation_required',error_code='reconciliation_required',updated_at=now() WHERE id=j.id;
   UPDATE public.sync_root_clock SET namespace_state='BACKEND_UNCERTAIN',updated_at=now() WHERE root_id=g.root_id AND namespace_state IN ('QUALIFYING','ACTIVE'); RETURN NULL;
 END IF;
 IF c.epoch::text<>i->>'epoch' OR c.binding_version::text<>i->>'bindingVersion' OR c.namespace_state<>'QUALIFYING'
   OR c.descriptor_schema<>'saturn.current-namespace.v1' THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.operation_journal WHERE sync_root_id=g.root_id AND sync_result IS NULL AND id<>(i->>'operationId')::uuid)
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
 SELECT * INTO parent FROM public.resources WHERE id=(i->>'parentId')::uuid;
 storage:=rtrim(parent.storage_path,'/')||'/'||(i->>'name');
 IF octet_length(storage)>32768 OR (j.id IS NOT NULL AND j.payload->>'storagePath' IS DISTINCT FROM storage) THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
 IF command='reserve' THEN
   IF j.id IS NOT NULL AND j.catalog_effect_state<>'prepared' THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   SELECT * INTO child FROM public.resources WHERE parent_id=parent.id AND lower(name)=lower(i->>'name') AND status='active' LIMIT 1;
   IF FOUND AND (child.type<>'folder' OR i->>'mode'<>'ensure') THEN RAISE EXCEPTION 'conflict' USING ERRCODE='23505'; END IF;
   IF j.id IS NULL THEN
     INSERT INTO public.operation_journal(id,operation_type,state,idempotency_key,payload,sync_root_id,sync_epoch,sync_intent_hash,catalog_intent,catalog_effect_state)
       VALUES((i->>'operationId')::uuid,'folder_create','created','catalog-folder:'||(i->>'idempotencyKey'),jsonb_build_object('storagePath',storage),g.root_id,c.epoch,h,i,'prepared');
   END IF;
   IF child.id IS NOT NULL THEN
     IF child.metadata_version IS NULL THEN RAISE EXCEPTION 'projection_mismatch' USING ERRCODE='55000'; END IF;
     descj:=jsonb_build_object('node_id',child.id,'parent_id',child.parent_id,'name',child.name,'type','folder','size_bytes',child.size_bytes::text,
       'content_sha256',NULL,'content_version_id',NULL,'version',child.metadata_version,'availability',coalesce(child.sync_availability,'UNKNOWN'));
     resultj:=jsonb_build_object('schema','saturn.catalog-folder-result.v1','operationId',i->>'operationId','intentHash',h,'rootId',g.root_id,'status','EXISTING','description',descj);
     UPDATE public.operation_journal SET state='active',resource_id=child.id,catalog_effect_state='not_required',sync_result=resultj,updated_at=now() WHERE id=(i->>'operationId')::uuid;
     RETURN jsonb_build_object('intent',i,'storagePath',storage,'outcome',jsonb_build_object('replayed',false,'result',resultj));
   END IF;
   RETURN jsonb_build_object('intent',i,'storagePath',storage);
 ELSIF command='claim' THEN
   IF j.catalog_effect_state<>'prepared' THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   UPDATE public.operation_journal SET catalog_effect_state='physical_pending',state='committing',updated_at=now() WHERE id=j.id; RETURN NULL;
 ELSIF command='commit' THEN
   IF j.catalog_effect_state<>'physical_pending' THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   INSERT INTO public.resources(id,type,parent_id,name,storage_path,status,sync_availability)
     VALUES((i->>'nodeId')::uuid,'folder',parent.id,i->>'name',storage,'active','AVAILABLE') RETURNING * INTO child;
   IF c.published_seq=9223372036854775807 THEN RAISE EXCEPTION 'counter_exhausted' USING ERRCODE='55000'; END IF; seq:=c.published_seq+1;
   descj:=jsonb_build_object('node_id',child.id,'parent_id',child.parent_id,'name',child.name,'type','folder','size_bytes',child.size_bytes::text,
     'content_sha256',NULL,'content_version_id',NULL,'version',child.metadata_version,'availability','AVAILABLE');
   resultj:=jsonb_build_object('schema','saturn.catalog-folder-result.v1','operationId',i->>'operationId','intentHash',h,'rootId',g.root_id,'status','CREATED','description',descj);
   INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document) VALUES(g.root_id,c.epoch,seq,child.id,j.id,
     jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',child.id,'kind','upsert','description',descj,'reason','folder.create','actor',actor));
   UPDATE public.operation_journal SET state='active',resource_id=child.id,catalog_effect_state='published',sync_first_seq=seq,sync_last_seq=seq,sync_result=resultj,updated_at=now() WHERE id=j.id;
   UPDATE public.sync_root_clock SET published_seq=seq,updated_at=now() WHERE root_id=g.root_id;
   RETURN jsonb_build_object('intent',i,'storagePath',storage,'outcome',jsonb_build_object('replayed',false,'result',resultj));
 END IF;
 RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';
END $$;
$catalog_upload_old$,'public.',quote_ident(current_schema())||'.');
END $catalog_upload_restore_guard$;
ALTER TABLE operation_journal DROP CONSTRAINT operation_sync_receipt_shape;
ALTER TABLE operation_journal DROP CONSTRAINT operation_upload_publication_shape;
ALTER TABLE operation_journal DROP CONSTRAINT operation_catalog_upload_shape;
DROP TRIGGER operation_catalog_upload_execution_guard ON operation_journal;
DROP FUNCTION guard_catalog_upload_execution();
DROP FUNCTION catalog_guard_upgrade_file(uuid);
DROP FUNCTION catalog_upload_command(text,jsonb,jsonb,jsonb);
DROP FUNCTION catalog_upload_transport(operation_journal);
DROP FUNCTION catalog_upload_shape(operation_journal);
DROP FUNCTION catalog_namespace_description(resources,uuid);
DROP FUNCTION catalog_upload_intent_valid(jsonb);
DROP FUNCTION catalog_upload_hash(jsonb);
DROP FUNCTION catalog_upload_topology_hash_input(jsonb);
ALTER TABLE operation_journal DROP COLUMN upload_execution,DROP COLUMN upload_effect_state,DROP COLUMN upload_transfer,DROP COLUMN upload_claim_token, DROP COLUMN upload_last_transfer;
ALTER TABLE catalog_guard_roots DROP CONSTRAINT catalog_guard_roots_writer_contract_check;
ALTER TABLE catalog_guard_roots ADD CONSTRAINT catalog_guard_roots_writer_contract_check CHECK(writer_contract='folder-only-g1.v1');

ALTER TABLE operation_journal ADD CONSTRAINT operation_upload_publication_shape CHECK (
  (upload_intent IS NULL AND upload_intent_hash IS NULL AND upload_receipt IS NULL AND upload_published_version_id IS NULL)
  OR COALESCE((operation_type='upload' AND upload_id=id AND upload_intent IS NOT NULL
   AND jsonb_typeof(upload_intent)='object' AND octet_length(upload_intent::text)<=8192
   AND upload_intent->>'schema'='saturn.upload-intent.v1'
   AND upload_intent_hash IS NOT NULL AND upload_intent_hash ~ '^[a-f0-9]{64}$'
   AND ((upload_receipt IS NULL AND upload_published_version_id IS NULL)
    OR (state='active' AND resource_id IS NOT NULL AND upload_published_version_id IS NOT NULL
     AND jsonb_typeof(upload_receipt)='object' AND octet_length(upload_receipt::text)<=16384
     AND upload_receipt->>'schema'='saturn.upload-publication.v1'
     AND upload_receipt->>'uploadId'=id::text AND upload_receipt->>'operationId'=id::text
     AND upload_receipt->>'intentHash'=upload_intent_hash
     AND upload_receipt->>'resourceId'=resource_id::text
     AND upload_receipt->>'versionId'=upload_published_version_id::text))),false)
 );

ALTER TABLE operation_journal ADD CONSTRAINT operation_sync_receipt_shape CHECK (
 (sync_root_id IS NULL AND sync_epoch IS NULL AND sync_first_seq IS NULL AND sync_last_seq IS NULL AND sync_intent_hash IS NULL AND sync_result IS NULL)
 OR (sync_root_id IS NOT NULL AND sync_epoch IS NOT NULL AND sync_intent_hash IS NOT NULL AND sync_intent_hash ~ '^[a-f0-9]{64}$'
   AND ((sync_first_seq IS NULL AND sync_last_seq IS NULL AND sync_result IS NULL)
     OR (sync_first_seq IS NOT NULL AND sync_last_seq IS NOT NULL AND sync_first_seq>0 AND sync_last_seq>=sync_first_seq AND sync_result IS NOT NULL AND state='active')
     OR (catalog_intent IS NOT NULL AND catalog_effect_state='not_required' AND sync_first_seq IS NULL AND sync_last_seq IS NULL
       AND state='active' AND sync_result->>'schema'='saturn.catalog-folder-result.v1' AND sync_result->>'status'='EXISTING' AND catalog_folder_shape(operation_journal))))
);

CREATE OR REPLACE FUNCTION guard_sealed_upload_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sealed operation_journal%ROWTYPE;
BEGIN
 SELECT * INTO sealed FROM operation_journal WHERE id=OLD.id AND upload_id=OLD.id;
 IF sealed.upload_intent IS NOT NULL THEN
  IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Sealed upload session cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.id,NEW.idempotency_key,NEW.parent_id,NEW.filename,NEW.expected_size,NEW.expected_sha256,
     NEW.overwrite_resource_id,NEW.expected_version_id,NEW.require_absent,NEW.audit_actor_type,NEW.audit_actor_id,NEW.temp_path)
   IS DISTINCT FROM ROW(OLD.id,OLD.idempotency_key,OLD.parent_id,OLD.filename,OLD.expected_size,OLD.expected_sha256,
     OLD.overwrite_resource_id,OLD.expected_version_id,OLD.require_absent,OLD.audit_actor_type,OLD.audit_actor_id,OLD.temp_path)
   OR (sealed.upload_receipt IS NOT NULL AND ROW(NEW.status,NEW.resource_id,NEW.actual_sha256,NEW.received_size)
    IS DISTINCT FROM ROW(OLD.status,OLD.resource_id,OLD.actual_sha256,OLD.received_size)) THEN
   RAISE EXCEPTION 'Sealed upload session identity/publication is immutable' USING ERRCODE='55000';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
