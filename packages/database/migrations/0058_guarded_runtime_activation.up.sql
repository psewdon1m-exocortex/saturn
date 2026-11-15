-- Explicit offline opt-in, no existing root activation or role/credential grant.
ALTER TABLE catalog_guard_roots ADD COLUMN active_runtime jsonb;
CREATE INDEX resources_lower_storage_path_idx ON resources(lower(storage_path));
DO $active_install$ BEGIN EXECUTE replace($active_literal$
CREATE FUNCTION catalog_guard_active_shape(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>8192 OR (SELECT count(*) FROM jsonb_object_keys(p))<>19
   OR NOT p ?& ARRAY['schema','rootId','serverEpoch','serverIdentity','policyVersion','backendIdentity','backendProfileId','backendProfileRevision','backendGeneration','fenceReceiptSha256','qualificationReceiptSha256','activationReceiptSha256','maximumFileBytes','observedMetadataVersion','observedPathSha256','observedAt','oldExecutorsDrained','oldCredentialsRevoked','emptyPhysicalRootVerified']
   OR p->>'schema'<>'saturn.catalog-active.v1' OR EXISTS(SELECT 1 FROM jsonb_each(p) WHERE key NOT IN ('backendProfileRevision','oldExecutorsDrained','oldCredentialsRevoked','emptyPhysicalRootVerified') AND jsonb_typeof(value)<>'string')
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['rootId','serverEpoch','serverIdentity','backendGeneration','observedMetadataVersion']) k WHERE p->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['fenceReceiptSha256','qualificationReceiptSha256','activationReceiptSha256','observedPathSha256']) k WHERE p->>k !~ '^[a-f0-9]{64}$')
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['policyVersion','backendIdentity','backendProfileId']) k WHERE p->>k !~ '^[A-Za-z0-9._:-]{1,128}$')
   OR jsonb_typeof(p->'backendProfileRevision')<>'number' OR p->>'backendProfileRevision' !~ '^[1-9][0-9]{0,9}$'
   OR p->>'maximumFileBytes' !~ '^[1-9][0-9]{0,9}$' OR (p->>'maximumFileBytes')::numeric>1073741824
   OR p->'oldExecutorsDrained'<>'true'::jsonb OR p->'oldCredentialsRevoked'<>'true'::jsonb OR p->'emptyPhysicalRootVerified'<>'true'::jsonb
   OR p->>'observedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- Append-only identity for ordinary outside/control-parent reservations. This
-- uses the existing journal, never authorizes a registered-root writer.
CREATE FUNCTION outside_folder_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.resources%ROWTYPE;p public.resources%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.operation_type='outside_folder_create' THEN
   IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.operation_type<>OLD.operation_type
     OR NEW.resource_id IS DISTINCT FROM OLD.resource_id OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.sync_root_id IS DISTINCT FROM OLD.sync_root_id OR NEW.upload_id IS DISTINCT FROM OLD.upload_id
     OR (OLD.state='active' AND NEW.state<>'active') THEN RAISE EXCEPTION 'outside original identity cannot be changed or deleted' USING ERRCODE='55000'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.operation_type<>'outside_folder_create' THEN RETURN NEW; END IF;
 SELECT * INTO r FROM public.resources WHERE id=NEW.resource_id;SELECT * INTO p FROM public.resources WHERE id=r.parent_id;
 IF NEW.id IS DISTINCT FROM NEW.resource_id OR NEW.upload_id IS NOT NULL OR NEW.sync_root_id IS NOT NULL OR NEW.sync_epoch IS NOT NULL
   OR NEW.catalog_intent IS NOT NULL OR NEW.upload_intent IS NOT NULL OR NEW.sync_result IS NOT NULL
   OR NEW.state NOT IN ('committing','active') OR NEW.error_code IS NOT NULL AND NEW.error_code<>'reconciliation_required'
   OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' OR octet_length(NEW.payload::text)>8192
   OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload))<>6 OR NEW.payload->>'schema' IS DISTINCT FROM 'saturn.outside-folder.v1'
   OR NEW.payload->>'nodeId' IS DISTINCT FROM r.id::text OR NEW.payload->>'parentId' IS DISTINCT FROM r.parent_id::text
   OR NEW.payload->>'name' IS DISTINCT FROM r.name OR NEW.payload->>'path' IS DISTINCT FROM r.storage_path
   OR NOT NEW.payload ?& ARRAY['schema','parentId','nodeId','name','path','authority']
   OR jsonb_typeof(NEW.payload->'authority') IS DISTINCT FROM 'string' OR NEW.payload->>'authority' !~ '^[a-f0-9]{64}$' OR p.type<>'folder' OR p.status<>'active'
   OR r.parent_id NOT IN ('00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000004','00000000-0000-7000-8000-000000000009')
   OR cardinality(public.catalog_guard_scope(r.id,false))<>0 OR r.status<>(CASE WHEN NEW.state='active' THEN 'active' ELSE 'pending' END)
   OR NOT EXISTS(SELECT 1 FROM public.catalog_guard_roots g WHERE '00000000-0000-7000-8000-000000000001'::uuid=ANY(g.control_ancestor_ids) AND (
      current_user=session_user AND g.runtime_role=session_user AND NEW.state='committing'
      OR current_user=g.writer_owner AND session_user=g.writer_login))
 THEN RAISE EXCEPTION 'outside original shape unqualified' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outside_folder_original_guard BEFORE INSERT OR UPDATE OR DELETE ON operation_journal FOR EACH ROW EXECUTE FUNCTION outside_folder_identity_guard();
CREATE FUNCTION outside_folder_pending_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF OLD.status='pending' AND EXISTS(SELECT 1 FROM public.operation_journal WHERE resource_id=OLD.id AND operation_type='outside_folder_create') THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'outside pending outcome requires reconciliation' USING ERRCODE='55000';END IF;
   IF NEW.status<>'active' OR NOT EXISTS(SELECT 1 FROM public.catalog_guard_roots g WHERE '00000000-0000-7000-8000-000000000001'::uuid=ANY(g.control_ancestor_ids) AND current_user=g.writer_owner AND session_user=g.writer_login)
     OR (to_jsonb(OLD)-ARRAY['status','updated_at','metadata_version'])<>(to_jsonb(NEW)-ARRAY['status','updated_at','metadata_version'])
     THEN RAISE EXCEPTION 'outside pending identity is sealed' USING ERRCODE='55000'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER outside_folder_pending_identity_guard BEFORE UPDATE OR DELETE ON resources FOR EACH ROW EXECUTE FUNCTION outside_folder_pending_guard();
CREATE FUNCTION outside_folder_commit(operation uuid,credential jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.operation_journal%ROWTYPE;r public.resources%ROWTYPE;p public.resources%ROWTYPE;g public.catalog_guard_roots%ROWTYPE;
BEGIN
 IF (SELECT n.nspname FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE t.oid='public.catalog_guard_roots'::regclass)<>'public' THEN RAISE EXCEPTION 'public namespace required' USING ERRCODE='42501';END IF;
 PERFORM set_config('lock_timeout','2s',true);PERFORM set_config('statement_timeout','2s',true);
 SELECT * INTO j FROM public.operation_journal WHERE id=operation;
 IF NOT FOUND OR j.operation_type<>'outside_folder_create' OR jsonb_typeof(credential) IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(credential))<>5 OR NOT credential ?& ARRAY['actorType','rootId','revision','sessionId','tokenHash']
   OR jsonb_typeof(credential->'actorType') IS DISTINCT FROM 'string' OR credential->>'actorType' NOT IN ('owner_bootstrap','owner_web')
   OR jsonb_typeof(credential->'rootId') IS DISTINCT FROM 'string' OR credential->>'rootId' IS DISTINCT FROM j.payload->>'parentId'
   OR jsonb_typeof(credential->'revision') IS DISTINCT FROM 'string' OR credential->>'revision' !~ '^[1-9][0-9]{0,18}$'
   THEN RAISE EXCEPTION 'authority_invalid' USING ERRCODE='42501';END IF;
 PERFORM root_id FROM public.sync_root_clock WHERE root_id IN (SELECT root_id FROM public.catalog_guard_roots WHERE '00000000-0000-7000-8000-000000000001'::uuid=ANY(control_ancestor_ids)) ORDER BY root_id FOR UPDATE;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE '00000000-0000-7000-8000-000000000001'::uuid=ANY(control_ancestor_ids) ORDER BY root_id LIMIT 1;
 IF g.root_id IS NULL OR current_user<>g.writer_owner OR session_user<>g.writer_login OR
   EXISTS(SELECT 1 FROM public.catalog_guard_roots x WHERE '00000000-0000-7000-8000-000000000001'::uuid=ANY(x.control_ancestor_ids) AND (x.writer_owner<>current_user OR x.writer_login<>session_user))
   THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='42501';END IF;
 IF credential->>'actorType'='owner_web' THEN
   IF jsonb_typeof(credential->'sessionId') IS DISTINCT FROM 'string' OR credential->>'sessionId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
     OR jsonb_typeof(credential->'tokenHash') IS DISTINCT FROM 'string' OR credential->>'tokenHash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'authority_invalid' USING ERRCODE='42501';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.web_sessions WHERE id=(credential->>'sessionId')::uuid AND token_hash=credential->>'tokenHash'
      AND state='active' AND idle_expires_at>now() AND expires_at>now() FOR SHARE) THEN RAISE EXCEPTION 'authorization_changed' USING ERRCODE='42501';END IF;
 ELSE
   IF credential->'sessionId'<>'null'::jsonb OR credential->'tokenHash'<>'null'::jsonb THEN RAISE EXCEPTION 'authority_invalid' USING ERRCODE='42501';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.owner_credentials WHERE owner_id='owner' AND revision::text=credential->>'revision' FOR SHARE)
   THEN RAISE EXCEPTION 'authorization_changed' USING ERRCODE='42501';END IF;
 -- The compact array contains only validated UUID/SHA/enums/decimal tokens,
 -- never names or free text. Remove PostgreSQL's delimiter spaces only to
 -- match the existing private issuer's exact JSON.stringify fingerprint.
 IF j.payload->>'authority' IS DISTINCT FROM encode(sha256(convert_to(replace(jsonb_build_array(
   'saturn.catalog-authority.v1',credential->>'actorType','owner',credential->>'rootId',credential->>'tokenHash',credential->>'sessionId',credential->>'revision',NULL,NULL)::text,', ',','),'UTF8')),'hex')
   THEN RAISE EXCEPTION 'authority_invalid' USING ERRCODE='42501';END IF;
 SELECT * INTO j FROM public.operation_journal WHERE id=operation FOR UPDATE;
 SELECT * INTO r FROM public.resources WHERE id=j.resource_id FOR UPDATE;
 SELECT * INTO p FROM public.resources WHERE id=r.parent_id FOR SHARE;
 IF j.state='active' THEN RETURN r.id;END IF;
 IF j.state<>'committing' OR j.error_code IS NOT NULL OR r.status<>'pending' OR r.type<>'folder' OR p.status<>'active' OR p.type<>'folder'
   OR r.id<>j.id OR r.parent_id::text<>j.payload->>'parentId' OR r.name<>j.payload->>'name' OR r.storage_path<>j.payload->>'path'
   OR cardinality(public.catalog_guard_scope(r.id,false))<>0 OR cardinality(public.catalog_guard_scope(p.id,false))<>0
   OR r.storage_path<>(CASE WHEN p.storage_path='' THEN r.name ELSE p.storage_path||'/'||r.name END)
   THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000';END IF;
 UPDATE public.resources SET status='active',updated_at=now() WHERE id=r.id;
 UPDATE public.operation_journal SET state='active',updated_at=now() WHERE id=j.id;
 RETURN r.id;
END $$;
CREATE FUNCTION catalog_guard_active_valid(g public.catalog_guard_roots) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.catalog_guard_active_shape(g.active_runtime) AND g.active_runtime->>'rootId'=g.root_id::text AND g.active_runtime->>'backendIdentity'=g.backend_identity
   AND g.writer_contract='folder-file-cas-cj04.v1'
   AND EXISTS(SELECT 1 FROM public.sync_root_clock c JOIN public.resources r ON r.id=c.root_id WHERE c.root_id=g.root_id AND c.epoch::text=g.active_runtime->>'serverEpoch'
     AND c.descriptor_schema='saturn.current-namespace.v1' AND r.type='folder' AND r.status='active' AND r.metadata_version IS NOT NULL)
$$;
-- Offline CLI/table owner only. Physical verification happens before this short SQL
-- transaction while all cooperating API/worker admissions and old credentials are drained.
CREATE FUNCTION catalog_guard_activation_preflight(g public.catalog_guard_roots) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.catalog_guard_active_valid(g) AND EXISTS(SELECT 1 FROM public.sync_root_clock c JOIN public.resources r ON r.id=c.root_id
   JOIN public.devices d ON d.sync_root_id=c.root_id
   WHERE c.root_id=g.root_id AND c.namespace_state='QUALIFYING' AND c.published_seq=0 AND c.retained_after_seq=0 AND r.sync_availability='AVAILABLE'
     AND r.metadata_version::text=g.active_runtime->>'observedMetadataVersion'
     AND encode(sha256(convert_to(r.storage_path,'UTF8')),'hex')=g.active_runtime->>'observedPathSha256'
     AND (g.active_runtime->>'observedAt')::timestamptz<=clock_timestamp()
     AND clock_timestamp()-(g.active_runtime->>'observedAt')::timestamptz<=interval '30 seconds'
     AND d.state='active' AND d.can_read AND d.can_write AND d.scope_ids=ARRAY[c.root_id]
     AND d.device_kind IN ('windows_sync','pluto') AND (d.expires_at IS NULL OR d.expires_at>now())
     AND r.parent_id=CASE WHEN d.device_kind='windows_sync' THEN '00000000-0000-7000-8000-000000000004'::uuid ELSE '00000000-0000-7000-8000-000000000009'::uuid END
     AND (SELECT count(*) FROM public.devices WHERE sync_root_id=c.root_id AND state='active')=1
     AND NOT EXISTS(SELECT 1 FROM public.resources WHERE parent_id=c.root_id OR trashed_from_parent_id=c.root_id)
     AND NOT EXISTS(SELECT 1 FROM public.operation_journal WHERE sync_root_id=c.root_id OR resource_id=c.root_id)
     AND NOT EXISTS(SELECT 1 FROM public.upload_sessions WHERE parent_id=c.root_id OR resource_id=c.root_id OR overwrite_resource_id=c.root_id)
     AND NOT EXISTS(SELECT 1 FROM public.sync_root_changes WHERE root_id=c.root_id))
$$;
CREATE FUNCTION catalog_guard_activate_empty(root uuid,proof jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.sync_root_clock%ROWTYPE;g public.catalog_guard_roots%ROWTYPE;r public.resources%ROWTYPE;d public.devices%ROWTYPE;
BEGIN
 IF (SELECT n.nspname FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE t.oid='public.catalog_guard_roots'::regclass)<>'public'
   OR current_user<>session_user OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_guard_roots'::regclass)
   OR NOT public.catalog_guard_active_shape(proof) THEN RAISE EXCEPTION 'offline_activation_unqualified' USING ERRCODE='42501'; END IF;
 PERFORM set_config('lock_timeout','2s',true);PERFORM set_config('statement_timeout','2s',true);
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=root FOR UPDATE;SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=root FOR UPDATE;SELECT * INTO r FROM public.resources WHERE id=root FOR SHARE;
 SELECT * INTO d FROM public.devices WHERE sync_root_id=root AND state='active' AND can_read AND can_write AND scope_ids=ARRAY[root] AND device_kind IN ('windows_sync','pluto') AND (expires_at IS NULL OR expires_at>now()) FOR SHARE;
 IF c.root_id IS NULL OR g.root_id IS NULL OR r.id IS NULL OR d.id IS NULL OR g.active_runtime IS NOT NULL OR g.writer_contract<>'folder-file-cas-cj04.v1'
   OR c.namespace_state<>'QUALIFYING' OR c.published_seq<>0 OR c.retained_after_seq<>0 OR c.epoch::text<>proof->>'serverEpoch' OR g.root_id::text<>proof->>'rootId'
   OR g.backend_identity<>proof->>'backendIdentity' OR r.type<>'folder' OR r.status<>'active' OR r.sync_availability<>'AVAILABLE' OR r.metadata_version::text IS DISTINCT FROM proof->>'observedMetadataVersion'
   OR r.parent_id IS DISTINCT FROM (CASE WHEN d.device_kind='windows_sync' THEN '00000000-0000-7000-8000-000000000004'::uuid ELSE '00000000-0000-7000-8000-000000000009'::uuid END)
   OR encode(sha256(convert_to(r.storage_path,'UTF8')),'hex')<>proof->>'observedPathSha256'
   OR (proof->>'observedAt')::timestamptz>clock_timestamp() OR clock_timestamp()-(proof->>'observedAt')::timestamptz>interval '30 seconds'
   OR EXISTS(SELECT 1 FROM public.resources WHERE parent_id=root OR trashed_from_parent_id=root)
   OR EXISTS(SELECT 1 FROM public.operation_journal WHERE sync_root_id=root OR resource_id=root)
   OR EXISTS(SELECT 1 FROM public.upload_sessions WHERE parent_id=root OR resource_id=root OR overwrite_resource_id=root)
   OR EXISTS(SELECT 1 FROM public.sync_root_changes WHERE root_id=root)
   OR (SELECT count(*) FROM public.devices WHERE sync_root_id=root AND state='active')<>1 THEN RAISE EXCEPTION 'empty_root_activation_unqualified' USING ERRCODE='55000'; END IF;
 UPDATE public.catalog_guard_roots SET active_runtime=proof,guard_revision=gen_random_uuid() WHERE root_id=root RETURNING * INTO g;
 UPDATE public.sync_root_clock SET namespace_state='ACTIVE',binding_version=gen_random_uuid(),updated_at=now() WHERE root_id=root RETURNING * INTO c;
 RETURN jsonb_build_object('rootId',root,'epoch',c.epoch,'bindingVersion',c.binding_version,'guardRevision',g.guard_revision,'activationReceiptSha256',proof->>'activationReceiptSha256');
END $$;
-- Close-only trusted writer function. It cannot return ACTIVE, publish metadata,
-- erase original keys, change proof/epoch or perform storage I/O.
CREATE FUNCTION catalog_guard_backend_uncertain(root uuid,generation uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE;c public.sync_root_clock%ROWTYPE;
BEGIN
 IF (SELECT n.nspname FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE t.oid='public.catalog_guard_roots'::regclass)<>'public' THEN RAISE EXCEPTION 'public namespace required' USING ERRCODE='42501';END IF;
 PERFORM set_config('lock_timeout','2s',true);PERFORM set_config('statement_timeout','2s',true);
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=root;
 IF NOT FOUND OR current_user<>g.writer_owner OR session_user<>g.writer_login OR NOT public.catalog_guard_active_valid(g) OR g.active_runtime->>'backendGeneration'<>generation::text THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=root FOR UPDATE;
 IF c.namespace_state='ACTIVE' THEN UPDATE public.sync_root_clock SET namespace_state='BACKEND_UNCERTAIN',updated_at=now() WHERE root_id=root RETURNING * INTO c;END IF;
 RETURN jsonb_build_object('rootId',root,'state',c.namespace_state,'bindingVersion',c.binding_version);
END $$;

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
       SELECT scoped||public.catalog_guard_scope(upload_row.parent_id) INTO scoped FROM public.upload_sessions upload_row WHERE upload_row.id=(row->>'upload_id')::uuid;
       ids:=ids||coalesce(scoped,'{}');
     END IF;
     IF row->'payload'->>'parentId' ~ '^[a-f0-9-]{36}$' THEN
       IF row->>'operation_type'='outside_folder_create' AND row->'payload'->>'schema'='saturn.outside-folder.v1'
         AND row->>'resource_id'=row->'payload'->>'nodeId' AND row->>'sync_root_id' IS NULL AND row->>'upload_id' IS NULL
       THEN ids:=ids||public.catalog_guard_scope((row->'payload'->>'parentId')::uuid,false);
       ELSE ids:=ids||public.catalog_guard_scope((row->'payload'->>'parentId')::uuid); END IF;
     END IF;
   ELSE ids:=array_append(ids,(row->>'root_id')::uuid);
   END IF;
 END LOOP;
 FOR g IN SELECT * FROM public.catalog_guard_roots WHERE root_id=ANY(ids) LOOP
   -- CONTROL aggregates do not change an in-root descriptor or topology.
   IF TG_TABLE_NAME='resources' AND TG_OP='UPDATE' THEN
   IF OLD.id<>g.root_id AND OLD.id=ANY(g.control_ancestor_ids)
     AND (to_jsonb(OLD)-ARRAY['size_bytes','updated_at','metadata_version'])=(to_jsonb(NEW)-ARRAY['size_bytes','updated_at','metadata_version']) THEN CONTINUE; END IF; END IF;
   -- Exact offline ACTIVE transition, never a callback/GUC/request permit.
   IF TG_TABLE_NAME='sync_root_clock' AND TG_OP='UPDATE' THEN
   IF OLD.namespace_state='QUALIFYING' AND NEW.namespace_state='ACTIVE'
     AND OLD.binding_version<>NEW.binding_version AND public.catalog_guard_activation_preflight(g)
     AND current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.sync_root_clock'::regclass)
     AND (to_jsonb(OLD)-ARRAY['namespace_state','binding_version','updated_at'])=(to_jsonb(NEW)-ARRAY['namespace_state','binding_version','updated_at']) THEN CONTINUE; END IF; END IF;
   -- No custom GUC/actor label/SET ROLE permit. Owner is NOLOGIN and caller has no membership.
   IF current_user<>g.writer_owner OR session_user<>g.writer_login THEN
     RAISE EXCEPTION 'catalog writer unqualified' USING ERRCODE='42501';
   END IF;
   IF g.writer_contract='folder-only-g1.v1' AND (TG_TABLE_NAME NOT IN ('resources','operation_journal','sync_root_clock','sync_root_changes')
     OR (TG_TABLE_NAME='resources' AND TG_OP<>'INSERT')) THEN
     RAISE EXCEPTION 'catalog writer path unsupported' USING ERRCODE='42501';
   END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION catalog_guard_registration() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.resources%ROWTYPE; c public.sync_root_clock%ROWTYPE; canonical uuid; controls uuid[];
BEGIN
 IF TG_TABLE_SCHEMA<>'public' THEN RAISE EXCEPTION 'catalog guard registration requires qualified public namespace' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' THEN
   IF current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_guard_roots'::regclass)
     AND OLD.active_runtime IS NULL AND NEW.active_runtime IS NOT NULL AND OLD.guard_revision<>NEW.guard_revision
     AND (to_jsonb(OLD)-ARRAY['active_runtime','guard_revision'])=(to_jsonb(NEW)-ARRAY['active_runtime','guard_revision'])
     AND public.catalog_guard_activation_preflight(NEW) THEN RETURN NEW; END IF;
   IF current_user<>OLD.writer_owner OR session_user<>OLD.writer_login OR OLD.writer_contract<>'folder-only-g1.v1' OR NEW.writer_contract<>'folder-file-cas-cj04.v1'
     OR NEW.guard_revision=OLD.guard_revision OR ROW(NEW.root_id,NEW.runtime_role,NEW.writer_login,NEW.writer_owner,NEW.backend_identity,NEW.control_ancestor_ids)
       IS DISTINCT FROM ROW(OLD.root_id,OLD.runtime_role,OLD.writer_login,OLD.writer_owner,OLD.backend_identity,OLD.control_ancestor_ids)
     OR EXISTS(SELECT 1 FROM public.operation_journal WHERE sync_root_id=OLD.root_id AND sync_result IS NULL) THEN
     RAISE EXCEPTION 'catalog guard upgrade unqualified' USING ERRCODE='42501'; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' OR NEW.writer_contract<>'folder-only-g1.v1' THEN RAISE EXCEPTION 'catalog guard retirement requires qualified migration' USING ERRCODE='55000'; END IF;
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
CREATE OR REPLACE FUNCTION catalog_upload_command(command text,input jsonb,credential jsonb,command_payload jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE; d public.devices%ROWTYPE; j public.operation_journal%ROWTYPE; u public.upload_sessions%ROWTYPE;
 p public.resources%ROWTYPE; child public.resources%ROWTYPE; r public.resources%ROWTYPE; i jsonb; e jsonb; h text; node uuid; version uuid; upload uuid; chain uuid[]:='{}'; inroot uuid[]:='{}'; cur uuid; n integer:=0; rh integer:=-1;
 target text; archive text; transfer jsonb; seq bigint; firstseq bigint; delta bigint; descj jsonb; beforej jsonb; topology jsonb:='[]'; paths jsonb:='[]'; resultj jsonb; receipt jsonb; published timestamptz; actor jsonb;
BEGIN
 IF (SELECT namespace_row.nspname FROM pg_class class_row JOIN pg_namespace namespace_row ON namespace_row.oid=class_row.relnamespace WHERE class_row.oid='public.catalog_guard_roots'::regclass) IS DISTINCT FROM 'public' THEN RAISE EXCEPTION 'public namespace required' USING ERRCODE='42501'; END IF;
 IF command IS NULL OR command NOT IN ('reserve','status','chunk','progress','verify','claim','commit','cancel','unknown') OR jsonb_typeof(input) IS DISTINCT FROM 'object' OR octet_length(input::text)>69632
   OR (SELECT count(*) FROM jsonb_object_keys(input))<>4 OR NOT input ?& ARRAY['epoch','bindingVersion','backendIdentity','intent']
   OR jsonb_typeof(command_payload) IS DISTINCT FROM 'object' OR octet_length(command_payload::text)>2048 OR jsonb_typeof(credential) IS DISTINCT FROM 'object' OR octet_length(credential::text)>512
   OR (SELECT count(*) FROM jsonb_object_keys(credential))<>3 OR NOT credential ?& ARRAY['deviceId','tokenHash','deviceKind']
   OR jsonb_typeof(credential->'deviceId') IS DISTINCT FROM 'string' OR credential->>'deviceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(credential->'tokenHash') IS DISTINCT FROM 'string' OR credential->>'tokenHash' !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(credential->'deviceKind') IS DISTINCT FROM 'string' OR credential->>'deviceKind' NOT IN ('windows_sync','pluto')
   OR jsonb_typeof(input->'epoch') IS DISTINCT FROM 'string' OR input->>'epoch' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(input->'bindingVersion') IS DISTINCT FROM 'string' OR input->>'bindingVersion' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(input->'backendIdentity') IS DISTINCT FROM 'string' OR input->>'backendIdentity' !~ '^[A-Za-z0-9._:-]{1,128}$' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 IF command='reserve' THEN
   IF NOT command_payload ?& ARRAY['uploadId','nodeId','versionId'] OR (SELECT count(*) FROM jsonb_object_keys(command_payload))<>(3+CASE WHEN command_payload ? 'originalUploadId' THEN 1 ELSE 0 END+CASE WHEN command_payload ? 'maximumFileBytes' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
   IF command_payload ? 'maximumFileBytes' AND (jsonb_typeof(command_payload->'maximumFileBytes') IS DISTINCT FROM 'string' OR command_payload->>'maximumFileBytes' !~ '^[1-9][0-9]{0,9}$' OR (command_payload->>'maximumFileBytes')::numeric>1073741824) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_each(command_payload) x WHERE x.key<>'maximumFileBytes' AND (jsonb_typeof(x.value) IS DISTINCT FROM 'string' OR x.value#>>'{}' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 ELSE
   IF jsonb_typeof(command_payload->'originalUploadId') IS DISTINCT FROM 'string' OR command_payload->>'originalUploadId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
   IF command IN ('chunk','progress') THEN
     IF (SELECT count(*) FROM jsonb_object_keys(command_payload))<>4 OR NOT command_payload ?& ARRAY['token','offset','length','originalUploadId']
       OR jsonb_typeof(command_payload->'token') IS DISTINCT FROM 'string' OR command_payload->>'token' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
       OR jsonb_typeof(command_payload->'offset') IS DISTINCT FROM 'string' OR command_payload->>'offset' !~ '^(0|[1-9][0-9]{0,18})$'
       OR jsonb_typeof(command_payload->'length') IS DISTINCT FROM 'string' OR command_payload->>'length' !~ '^[1-9][0-9]{0,7}$' OR (command_payload->>'length')::numeric>8388608 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
   ELSIF command='verify' THEN
     IF (SELECT count(*) FROM jsonb_object_keys(command_payload))<>4 OR NOT command_payload ?& ARRAY['sizeBytes','sha256','mimeType','originalUploadId']
       OR jsonb_typeof(command_payload->'sizeBytes') IS DISTINCT FROM 'string' OR jsonb_typeof(command_payload->'sha256') IS DISTINCT FROM 'string' OR jsonb_typeof(command_payload->'mimeType') IS DISTINCT FROM 'string' OR length(command_payload->>'mimeType') NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
   ELSIF command='claim' THEN
     IF (SELECT count(*) FROM jsonb_object_keys(command_payload))<>2 OR jsonb_typeof(command_payload->'claimToken') IS DISTINCT FROM 'string' OR command_payload->>'claimToken' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
   ELSIF command='commit' THEN
     IF (SELECT count(*) FROM jsonb_object_keys(command_payload))<>2 OR jsonb_typeof(command_payload->'mimeType') IS DISTINCT FROM 'string' OR length(command_payload->>'mimeType') NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
   ELSIF (SELECT count(*) FROM jsonb_object_keys(command_payload))<>1 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 END IF;
 i:=input->'intent'; IF NOT public.catalog_upload_intent_valid(i) OR credential->>'deviceId' IS DISTINCT FROM i->>'deviceId' OR credential->>'deviceKind' IS DISTINCT FROM i->>'deviceKind' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 h:=public.catalog_upload_hash(i); actor:=jsonb_build_object('type','device_token','id',i->>'deviceId');
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=(i->>'rootId')::uuid;
 IF NOT FOUND OR g.writer_contract<>'folder-file-cas-cj04.v1' OR current_user<>g.writer_owner OR session_user<>g.writer_login OR g.backend_identity IS DISTINCT FROM input->>'backendIdentity' THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=g.root_id FOR UPDATE;
 IF command<>'unknown' THEN
   SELECT * INTO d FROM public.devices WHERE id=(i->>'deviceId')::uuid FOR SHARE;
   SELECT * INTO p FROM public.resources WHERE id=g.root_id;
   IF NOT FOUND OR d.id IS NULL OR d.state<>'active' OR NOT d.can_write OR d.token_hash IS DISTINCT FROM credential->>'tokenHash' OR d.device_kind IS DISTINCT FROM i->>'deviceKind'
     OR d.sync_root_id IS DISTINCT FROM g.root_id OR d.scope_ids IS DISTINCT FROM ARRAY[g.root_id] OR (d.expires_at IS NOT NULL AND d.expires_at<=now())
     OR p.status<>'active' OR p.type<>'folder' OR p.parent_id IS DISTINCT FROM (CASE WHEN d.device_kind='windows_sync' THEN '00000000-0000-7000-8000-000000000004'::uuid ELSE '00000000-0000-7000-8000-000000000009'::uuid END) THEN RAISE EXCEPTION 'authorization_changed' USING ERRCODE='42501'; END IF;
 END IF;
 -- Original same-key lookup precedes mutable target/version/binding checks. Random candidates never replace accepted identity.
 SELECT * INTO j FROM public.operation_journal WHERE idempotency_key=i->>'idempotencyKey' FOR UPDATE;
 IF FOUND THEN
   IF j.upload_execution IS NULL OR j.upload_intent IS DISTINCT FROM i OR j.upload_intent_hash IS DISTINCT FROM h OR j.sync_root_id<>g.root_id
     OR j.upload_execution->>'epoch' IS DISTINCT FROM input->>'epoch' OR j.upload_execution->>'bindingVersion' IS DISTINCT FROM input->>'bindingVersion'
     OR j.upload_execution->>'backendIdentity' IS DISTINCT FROM input->>'backendIdentity'
     OR (command_payload ? 'originalUploadId' AND command_payload->>'originalUploadId' IS DISTINCT FROM j.id::text) THEN RAISE EXCEPTION 'operation_reused' USING ERRCODE='55000'; END IF;
   SELECT * INTO u FROM public.upload_sessions WHERE id=j.id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'projection_mismatch' USING ERRCODE='55000'; END IF;
   IF j.sync_result IS NOT NULL THEN RETURN jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object('uploadId',j.id,'operationId',j.id,'rootId',g.root_id,'intentHash',h,'expectedSizeBytes',u.expected_size::text,'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'result',j.sync_result,'replayed',true); END IF;
   IF command IN ('reserve','status') THEN RETURN jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object('uploadId',j.id,'operationId',j.id,'rootId',g.root_id,'intentHash',h,'expectedSizeBytes',u.expected_size::text,'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'replayed',true); END IF;
 ELSIF command<>'reserve' THEN RAISE EXCEPTION 'operation_reused' USING ERRCODE='55000'; END IF;
 IF command='status' THEN RETURN jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object('uploadId',j.id,'operationId',j.id,'rootId',g.root_id,'intentHash',h,'expectedSizeBytes',u.expected_size::text,'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'replayed',true); END IF;
 IF command='unknown' THEN
   IF j.upload_effect_state NOT IN ('physical_pending','reconciliation_required') THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   UPDATE public.operation_journal SET upload_effect_state='reconciliation_required',error_code='reconciliation_required',updated_at=now() WHERE id=j.id;
   UPDATE public.sync_root_clock SET namespace_state='BACKEND_UNCERTAIN',updated_at=now() WHERE root_id=g.root_id AND namespace_state IN ('QUALIFYING','ACTIVE');
 ELSE
   IF c.epoch::text IS DISTINCT FROM input->>'epoch' OR c.binding_version::text IS DISTINCT FROM input->>'bindingVersion' OR NOT (c.namespace_state='QUALIFYING' OR c.namespace_state='ACTIVE' AND public.catalog_guard_active_valid(g) AND i->>'schema'='saturn.upload-intent.v2') OR c.descriptor_schema<>'saturn.current-namespace.v1'
     OR (j.upload_execution IS NOT NULL AND j.upload_execution->>'guardRevision' IS DISTINCT FROM g.guard_revision::text) THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='55000'; END IF;
   IF EXISTS(SELECT 1 FROM public.operation_journal x WHERE x.sync_root_id=g.root_id AND x.sync_result IS NULL AND x.id IS DISTINCT FROM j.id AND NOT public.catalog_upload_transport(x)) THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   IF command='reserve' AND j.id IS NULL THEN
     IF c.namespace_state='ACTIVE' AND NOT command_payload ? 'maximumFileBytes' THEN RAISE EXCEPTION 'binding_invalid' USING ERRCODE='55000'; END IF;
     IF (command_payload ? 'maximumFileBytes' AND (i->>'sizeBytes')::numeric>(command_payload->>'maximumFileBytes')::numeric)
       OR (c.namespace_state='ACTIVE' AND (i->>'sizeBytes')::numeric>(g.active_runtime->>'maximumFileBytes')::numeric) THEN RAISE EXCEPTION 'upload_too_large' USING ERRCODE='22023'; END IF;
   END IF;
   IF command IN ('reserve','claim','commit') THEN
     cur:=(i->>'parentId')::uuid;
     LOOP
       IF cur=ANY(chain) OR n>130 THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
       SELECT * INTO p FROM public.resources WHERE id=cur LIMIT 1;
       IF NOT FOUND OR p.type<>'folder' OR p.status<>'active' OR (rh<0 AND p.metadata_version IS NULL) OR octet_length(p.storage_path)>4096 THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
       chain:=array_append(chain,cur); IF rh<0 THEN
         inroot:=array_append(inroot,cur);
         topology:=topology||jsonb_build_array(jsonb_build_object('nodeId',p.id,'parentId',CASE WHEN p.id=g.root_id THEN NULL ELSE p.parent_id END,'name',p.name));
         paths:=paths||jsonb_build_array(jsonb_build_object('nodeId',p.id,'storagePath',p.storage_path));
       END IF; IF cur=g.root_id THEN rh:=n; END IF;
       IF cur<>g.root_id AND EXISTS(SELECT 1 FROM public.sync_root_clock WHERE root_id=cur) THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
       IF p.parent_id IS NULL THEN EXIT; END IF; cur:=p.parent_id;n:=n+1;
     END LOOP;
     IF cur<>'00000000-0000-7000-8000-000000000001'::uuid OR rh<0 OR rh>=128 OR (i->>'schema'='saturn.upload-intent.v2' AND topology IS DISTINCT FROM i->'parentTopology')
       OR (j.id IS NOT NULL AND j.upload_execution->'pathTopology' IS DISTINCT FROM paths) THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
     -- All namespace locks, including overwrite target, have one sorted UUID order.
     PERFORM id FROM public.resources WHERE id=ANY(chain||CASE WHEN i->>'targetId' IS NULL THEN '{}'::uuid[] ELSE ARRAY[(i->>'targetId')::uuid] END) ORDER BY id FOR NO KEY UPDATE;
     SELECT * INTO p FROM public.resources WHERE id=(i->>'parentId')::uuid;
     target:=rtrim(p.storage_path,'/')||'/'||(i->>'name');
     SELECT * INTO child FROM public.resources WHERE parent_id=p.id AND lower(name)=lower(i->>'name') AND status<>'trashed' LIMIT 1;
     IF (i->>'requireAbsent')::boolean THEN
       IF FOUND THEN RAISE EXCEPTION 'precondition_failed' USING ERRCODE='23505'; END IF;
     ELSE
       IF NOT FOUND OR child.id::text IS DISTINCT FROM i->>'targetId' OR child.type<>'file' OR child.status<>'active' OR child.metadata_version::text IS DISTINCT FROM i->'condition'->>'metadataVersion'
         OR child.current_version_id::text IS DISTINCT FROM i->>'expectedVersionId' OR child.sync_availability IS DISTINCT FROM 'AVAILABLE' THEN RAISE EXCEPTION 'precondition_failed' USING ERRCODE='55000'; END IF;
     END IF;
     IF octet_length(target)>4096 OR (j.id IS NOT NULL AND j.upload_execution->>'targetPath' IS DISTINCT FROM target) THEN RAISE EXCEPTION 'membership_changed' USING ERRCODE='55000'; END IF;
   END IF;
   IF command='reserve' THEN
     IF j.id IS NULL THEN
       IF (SELECT count(*) FROM public.operation_journal x WHERE x.sync_root_id=g.root_id AND x.sync_result IS NULL)>=4 THEN RAISE EXCEPTION 'admission_full' USING ERRCODE='55000'; END IF;
       upload:=(command_payload->>'uploadId')::uuid;node:=coalesce(child.id,(command_payload->>'nodeId')::uuid);version:=(command_payload->>'versionId')::uuid;
       IF upload IS NULL OR node IS NULL OR version IS NULL OR upload=node OR upload=version OR node=version THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
       archive:=CASE WHEN child.id IS NULL THEN NULL ELSE '_system/versions/'||child.id::text||'/'||child.current_version_id::text END;
       e:=jsonb_build_object('schema','saturn.catalog-upload-execution.v1','epoch',c.epoch,'bindingVersion',c.binding_version,'guardRevision',g.guard_revision,'backendIdentity',g.backend_identity,
         'nodeId',node,'versionId',version,'tempPath','_system/incoming/'||upload::text||'.part','targetPath',target,'archivePath',archive,'before',CASE WHEN child.id IS NULL THEN NULL ELSE public.catalog_namespace_description(child,g.root_id) END,'pathTopology',paths);
       INSERT INTO public.upload_sessions(id,idempotency_key,parent_id,filename,temp_path,target_path,expected_size,expected_sha256,status,expires_at,overwrite_resource_id,expected_version_id,require_absent,audit_actor_type,audit_actor_id)
         VALUES(upload,i->>'idempotencyKey',p.id,i->>'name',e->>'tempPath',target,(i->>'sizeBytes')::bigint,i->>'sha256','created',now()+interval '24 hours',child.id,child.current_version_id,(i->>'requireAbsent')::boolean,'device_token',i->>'deviceId');
       INSERT INTO public.operation_journal(id,operation_type,state,idempotency_key,upload_id,payload,upload_intent,upload_intent_hash,sync_root_id,sync_epoch,sync_intent_hash,upload_execution,upload_effect_state)
         VALUES(upload,'upload','created',i->>'idempotencyKey',upload,jsonb_build_object('parentId',p.id,'filename',i->>'name'),i,h,g.root_id,c.epoch,h,e,'transport') RETURNING * INTO j;
       SELECT * INTO u FROM public.upload_sessions WHERE id=upload;
     ELSIF j.upload_effect_state NOT IN ('transport','verified') THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
   ELSIF command='chunk' THEN
     IF j.upload_effect_state<>'transport' OR j.upload_transfer IS NOT NULL OR command_payload->>'offset' IS DISTINCT FROM u.received_size::text OR command_payload->>'length' !~ '^[1-9][0-9]{0,7}$'
       OR (command_payload->>'length')::bigint>8388608 OR u.received_size+(command_payload->>'length')::bigint>u.expected_size OR command_payload->>'token' !~ '^[a-f0-9-]{36}$' THEN RAISE EXCEPTION 'transfer_unresolved' USING ERRCODE='55000'; END IF;
     UPDATE public.operation_journal SET upload_transfer=command_payload,updated_at=now() WHERE id=j.id;
     UPDATE public.upload_sessions SET status='uploading',updated_at=now() WHERE id=j.id;
   ELSIF command='progress' THEN
     IF j.upload_last_transfer=command_payload AND j.upload_transfer IS NULL THEN NULL;
     ELSIF j.upload_effect_state='transport' AND j.upload_transfer=command_payload THEN
       UPDATE public.upload_sessions SET received_size=received_size+(command_payload->>'length')::bigint,updated_at=now() WHERE id=j.id;
       UPDATE public.operation_journal SET upload_transfer=NULL,upload_last_transfer=command_payload,updated_at=now() WHERE id=j.id;
     ELSE RAISE EXCEPTION 'transfer_unresolved' USING ERRCODE='55000'; END IF;
   ELSIF command='verify' THEN
     IF j.upload_effect_state NOT IN ('transport','verified') OR j.upload_transfer IS NOT NULL OR u.received_size<>u.expected_size OR command_payload->>'sha256' IS DISTINCT FROM i->>'sha256' OR command_payload->>'sizeBytes' IS DISTINCT FROM i->>'sizeBytes'
       OR jsonb_typeof(command_payload->'mimeType') IS DISTINCT FROM 'string' OR length(command_payload->>'mimeType') NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'verification_failed' USING ERRCODE='55000'; END IF;
     UPDATE public.operation_journal SET upload_effect_state='verified',updated_at=now() WHERE id=j.id;
     UPDATE public.upload_sessions SET status='verifying',actual_sha256=i->>'sha256',updated_at=now() WHERE id=j.id;
   ELSIF command='claim' THEN
     IF j.upload_effect_state<>'verified' THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
     IF c.published_seq>9223372036854775807-(CASE WHEN u.expected_size=coalesce(child.size_bytes,0) THEN 1 ELSE cardinality(inroot)+1 END) THEN RAISE EXCEPTION 'counter_exhausted' USING ERRCODE='55000'; END IF;
     UPDATE public.operation_journal SET upload_effect_state='physical_pending',upload_claim_token=(command_payload->>'claimToken')::uuid,state='committing',updated_at=now() WHERE id=j.id;
     UPDATE public.upload_sessions SET status='committing',updated_at=now() WHERE id=j.id;
   ELSIF command='cancel' THEN
     IF j.upload_effect_state NOT IN ('transport','verified') OR j.upload_transfer IS NOT NULL THEN RAISE EXCEPTION 'reconciliation_required' USING ERRCODE='55000'; END IF;
     resultj:=jsonb_build_object('schema','saturn.catalog-upload-result.v2','status','NOT_PUBLISHED','uploadId',j.id,'operationId',j.id,'rootId',g.root_id,'intentHash',h,'reason','cancelled_before_publication');
     UPDATE public.operation_journal SET upload_effect_state='not_published',state='active',sync_result=resultj,updated_at=now() WHERE id=j.id;
     UPDATE public.upload_sessions SET status='abandoned',updated_at=now() WHERE id=j.id;
   ELSIF command='commit' THEN
     IF j.upload_effect_state<>'physical_pending' OR u.received_size<>u.expected_size OR u.actual_sha256 IS DISTINCT FROM i->>'sha256'
       OR jsonb_typeof(command_payload->'mimeType') IS DISTINCT FROM 'string' OR length(command_payload->>'mimeType') NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'verification_failed' USING ERRCODE='55000'; END IF;
     e:=j.upload_execution;node:=(e->>'nodeId')::uuid;version:=(e->>'versionId')::uuid;delta:=u.expected_size-coalesce(child.size_bytes,0);
     beforej:=CASE WHEN child.id IS NULL THEN NULL ELSE public.catalog_namespace_description(child,g.root_id) END;
     IF beforej IS DISTINCT FROM e->'before' AND NOT (beforej IS NULL AND e->'before'='null'::jsonb) THEN RAISE EXCEPTION 'precondition_failed' USING ERRCODE='55000'; END IF;
     IF child.id IS NULL THEN
       INSERT INTO public.resources(id,type,parent_id,name,storage_path,mime_type,size_bytes,sha256,status,sync_availability) VALUES(node,'file',p.id,i->>'name',target,command_payload->>'mimeType',u.expected_size,i->>'sha256','active','AVAILABLE');
     ELSE
       UPDATE public.file_versions SET storage_path=e->>'archivePath' WHERE id=child.current_version_id AND resource_id=child.id;
     END IF;
     INSERT INTO public.file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason) VALUES(version,node,target,i->>'sha256',u.expected_size,command_payload->>'mimeType',CASE WHEN child.id IS NULL THEN 'initial' ELSE 'overwrite' END) RETURNING created_at INTO published;
     UPDATE public.resources SET size_bytes=u.expected_size,sha256=i->>'sha256',current_version_id=version,mime_type=command_payload->>'mimeType',updated_at=now() WHERE id=node;
     UPDATE public.resources SET sync_availability='AVAILABLE' WHERE id=node RETURNING * INTO r;
     IF c.published_seq>9223372036854775807-(CASE WHEN delta=0 THEN 1 ELSE cardinality(inroot)+1 END) THEN RAISE EXCEPTION 'counter_exhausted' USING ERRCODE='55000'; END IF;
     firstseq:=c.published_seq+1;seq:=c.published_seq;
     descj:=public.catalog_namespace_description(r,g.root_id);seq:=seq+1;
     INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document) VALUES(g.root_id,c.epoch,seq,node,j.id,jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',node,'kind','upsert','description',descj,'reason','upload.publish','actor',actor));
     IF delta<>0 THEN
       UPDATE public.resources SET size_bytes=size_bytes+delta,updated_at=now() WHERE id=ANY(chain);
       FOR r IN SELECT * FROM public.resources WHERE id=ANY(inroot) ORDER BY id LOOP
         seq:=seq+1;INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document) VALUES(g.root_id,c.epoch,seq,r.id,j.id,jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',r.id,'kind','upsert','description',public.catalog_namespace_description(r,g.root_id),'reason','upload.ancestor','actor',actor));
       END LOOP;
     END IF;
     receipt:=jsonb_build_object('schema','saturn.upload-publication.v1','uploadId',j.id,'operationId',j.id,'intentHash',h,'rootId',g.root_id,'resourceId',node,'versionId',version,'parentId',p.id,'name',i->>'name','sizeBytes',u.expected_size::text,'sha256',i->>'sha256','etag','"sha256-'||(i->>'sha256')||'"','publishedAt',to_char(published AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
     resultj:=jsonb_build_object('schema','saturn.catalog-upload-result.v2','status','PUBLISHED','uploadId',j.id,'operationId',j.id,'rootId',g.root_id,'intentHash',h,'publicationReceipt',receipt,'publishedDescription',descj,'firstSeq',firstseq::text,'lastSeq',seq::text);
     UPDATE public.upload_sessions SET status='active',resource_id=node,updated_at=now() WHERE id=j.id;
     UPDATE public.operation_journal SET state='active',resource_id=node,upload_effect_state='published',upload_receipt=receipt,upload_published_version_id=version,sync_first_seq=firstseq,sync_last_seq=seq,sync_result=resultj,updated_at=now() WHERE id=j.id;
     UPDATE public.sync_root_clock SET published_seq=seq,updated_at=now() WHERE root_id=g.root_id;
   ELSE RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 END IF;
 SELECT * INTO j FROM public.operation_journal WHERE id=j.id;SELECT * INTO u FROM public.upload_sessions WHERE id=j.id;
 RETURN jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object('uploadId',j.id,'operationId',j.id,'rootId',g.root_id,'intentHash',h,'expectedSizeBytes',u.expected_size::text,'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'result',j.sync_result,'replayed',false);
END $$;
CREATE OR REPLACE FUNCTION catalog_folder_v2_command(command text,i jsonb,credential jsonb,command_payload jsonb) RETURNS jsonb
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
 IF c.epoch::text<>i->>'epoch' OR c.binding_version::text<>i->>'bindingVersion' OR NOT (c.namespace_state='QUALIFYING' OR c.namespace_state='ACTIVE' AND public.catalog_guard_active_valid(g))
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
CREATE OR REPLACE FUNCTION catalog_guard_read_admission(root uuid,epoch_value uuid,binding_value uuid,revision_value uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.sync_root_clock c
   JOIN public.catalog_guard_roots g ON g.root_id=c.root_id JOIN public.resources r ON r.id=c.root_id
   WHERE c.root_id=root AND c.epoch=epoch_value AND c.binding_version=binding_value
     AND (c.namespace_state='QUALIFYING' OR c.namespace_state='ACTIVE' AND public.catalog_guard_active_valid(g)) AND c.descriptor_schema='saturn.current-namespace.v1'
     AND g.guard_revision=revision_value AND g.writer_contract IN ('folder-only-g1.v1','folder-file-cas-cj04.v1')
     AND r.status='active' AND r.type='folder'
     AND (SELECT count(*) FROM (SELECT j.id FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL LIMIT 5) bounded)<=4
     AND NOT EXISTS(SELECT 1 FROM (SELECT j AS journal FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL LIMIT 5) pending
       WHERE NOT public.catalog_upload_private_read(pending.journal)))
$$;
CREATE OR REPLACE FUNCTION renew_resource_metadata_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.sync_availability='AVAILABLE' AND NEW.sync_availability='AVAILABLE'
    AND (NEW.storage_path IS DISTINCT FROM OLD.storage_path OR ROW(NEW.parent_id,NEW.name,NEW.type,NEW.size_bytes,NEW.sha256,NEW.current_version_id,NEW.status) IS DISTINCT FROM
        ROW(OLD.parent_id,OLD.name,OLD.type,OLD.size_bytes,OLD.sha256,OLD.current_version_id,OLD.status))
  THEN
    IF OLD.type='folder' AND NEW.type='folder'
      AND (to_jsonb(OLD)-ARRAY['size_bytes','updated_at','metadata_version'])=(to_jsonb(NEW)-ARRAY['size_bytes','updated_at','metadata_version'])
      AND EXISTS(SELECT 1 FROM public.catalog_guard_roots g JOIN public.sync_root_clock c ON c.root_id=g.root_id
        WHERE c.namespace_state IN ('QUALIFYING','ACTIVE') AND (
          g.root_id=ANY(public.catalog_guard_scope(OLD.id,false))
            AND current_user=g.writer_owner AND session_user=g.writer_login
          OR OLD.id=ANY(g.control_ancestor_ids) AND current_user=session_user AND session_user=g.runtime_role))
    THEN NULL;
    ELSE NEW.sync_availability:='UNKNOWN'; END IF;
    -- An unqualified legacy/direct writer cannot carry old verification forward.
    -- The prepared verified publication sets AVAILABLE explicitly after its DML.
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.metadata_version := gen_random_uuid();
  ELSIF ROW(NEW.parent_id,NEW.name,NEW.type,NEW.size_bytes,NEW.sha256,NEW.current_version_id,NEW.status,
             coalesce(NEW.sync_availability,'UNKNOWN')) IS DISTINCT FROM
        ROW(OLD.parent_id,OLD.name,OLD.type,OLD.size_bytes,OLD.sha256,OLD.current_version_id,OLD.status,
             coalesce(OLD.sync_availability,'UNKNOWN')) THEN
    NEW.metadata_version := gen_random_uuid();
  ELSIF OLD.metadata_version IS NOT NULL THEN
    NEW.metadata_version := OLD.metadata_version;
  ELSIF NEW.metadata_version IS NOT NULL THEN
    -- Explicit bounded initialization of a legacy row; never supplies historical events.
    NEW.metadata_version := gen_random_uuid();
  END IF;
  RETURN NEW;
END $$;
$active_literal$,'public.',quote_ident(current_schema())||'.'); END $active_install$;
ALTER TABLE catalog_guard_roots ADD CONSTRAINT catalog_guard_active_shape CHECK(active_runtime IS NULL OR catalog_guard_active_shape(active_runtime));
REVOKE ALL ON FUNCTION catalog_guard_activate_empty(uuid,jsonb),catalog_guard_backend_uncertain(uuid,uuid),outside_folder_commit(uuid,jsonb) FROM PUBLIC;
