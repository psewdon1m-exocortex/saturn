CREATE TABLE sync_scrub_progress(id boolean PRIMARY KEY CHECK(id),version_id uuid,offset_bytes bigint NOT NULL,bytes_this_run bigint NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE sync_backend_handoffs(id uuid PRIMARY KEY,backend_identity text NOT NULL,previous_generation uuid NOT NULL,next_generation uuid NOT NULL,
 receipt jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON sync_backend_handoffs FROM PUBLIC;
CREATE TABLE sync_migration_plans(
 id uuid PRIMARY KEY,root_id uuid NOT NULL REFERENCES resources(id),plan_sha256 text NOT NULL,tree_sha256 text NOT NULL,
 custody_sha256 text NOT NULL CHECK(custody_sha256 ~ '^[a-f0-9]{64}$'),
 expected_epoch uuid,expected_binding uuid,expected_seq bigint NOT NULL,node_count bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('PREPARED','VERIFYING','VERIFIED','APPLIED','BLOCKED')),last_node_id uuid,
 verified_nodes bigint NOT NULL DEFAULT 0,initialization_done boolean NOT NULL DEFAULT false,plan jsonb NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sync_migration_progress(plan_id uuid NOT NULL REFERENCES sync_migration_plans(id),node_id uuid NOT NULL,
 fingerprint text NOT NULL,evidence jsonb NOT NULL,verified_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(plan_id,node_id));
INSERT INTO sync_extension_function_backup SELECT 65,p.oid::regprocedure::text,pg_get_functiondef(p.oid)
 FROM pg_proc p WHERE p.oid IN ('catalog_guard_registration()'::regprocedure,'catalog_guard_rows()'::regprocedure,'renew_namespace_binding_version()'::regprocedure,'catalog_guard_active_valid(catalog_guard_roots)'::regprocedure);
-- Keep the v1 empty-root admission unchanged; v2 adds a complete offline plan.
ALTER FUNCTION catalog_guard_active_shape(jsonb) RENAME TO catalog_guard_active_shape_v1;
CREATE FUNCTION catalog_guard_active_shape(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p->>'schema'='saturn.catalog-active.v2' THEN
   (SELECT count(*) FROM jsonb_object_keys(p))=21 AND p->'emptyPhysicalRootVerified'='false'::jsonb AND p->>'adoptionPlanId' ~ '^[a-f0-9-]{36}$' AND p->>'treeSha256' ~ '^[a-f0-9]{64}$'
   AND public.catalog_guard_active_shape_v1((p-ARRAY['adoptionPlanId','treeSha256'])||jsonb_build_object('schema','saturn.catalog-active.v1','emptyPhysicalRootVerified',true))
 ELSE public.catalog_guard_active_shape_v1(p) END
$$;
ALTER TABLE catalog_guard_roots DROP CONSTRAINT catalog_guard_active_shape;
ALTER TABLE catalog_guard_roots ADD CONSTRAINT catalog_guard_active_shape CHECK(active_runtime IS NULL OR catalog_guard_active_shape(active_runtime));
CREATE OR REPLACE FUNCTION catalog_guard_active_valid(g public.catalog_guard_roots) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.catalog_guard_active_shape(g.active_runtime) AND g.active_runtime->>'rootId'=g.root_id::text AND g.active_runtime->>'backendIdentity'=g.backend_identity
   AND g.writer_contract='folder-file-cas-cj04.v1'
   AND EXISTS(SELECT 1 FROM public.sync_root_clock c JOIN public.resources r ON r.id=c.root_id WHERE c.root_id=g.root_id AND c.epoch::text=g.active_runtime->>'serverEpoch'
     AND c.descriptor_schema='saturn.current-namespace.v1' AND r.type='folder' AND r.status='active' AND r.metadata_version IS NOT NULL)
$$;
ALTER FUNCTION catalog_guard_activation_preflight(catalog_guard_roots) RENAME TO catalog_guard_activation_preflight_v1;
CREATE FUNCTION catalog_guard_activation_preflight(g public.catalog_guard_roots) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN g.active_runtime->>'schema'='saturn.catalog-active.v2' THEN public.catalog_guard_active_valid(g)
   AND EXISTS(SELECT 1 FROM public.sync_migration_plans p JOIN public.sync_root_clock c ON c.root_id=p.root_id JOIN public.resources r ON r.id=p.root_id
     WHERE p.id::text=g.active_runtime->>'adoptionPlanId' AND p.root_id=g.root_id AND p.state='VERIFIED' AND p.verified_nodes=p.node_count
       AND p.tree_sha256=g.active_runtime->>'treeSha256' AND c.namespace_state IN ('QUALIFYING','ACTIVE','BACKEND_UNCERTAIN') AND c.published_seq=p.expected_seq
       AND c.epoch=p.expected_epoch AND c.binding_version=p.expected_binding
       AND EXISTS(SELECT 1 FROM public.sync_backend_executor b WHERE b.backend_identity=g.backend_identity AND b.state='STOPPED' AND b.generation::text=g.active_runtime->>'backendGeneration')
       AND r.metadata_version::text=g.active_runtime->>'observedMetadataVersion'
       AND encode(sha256(convert_to(r.storage_path,'UTF8')),'hex')=g.active_runtime->>'observedPathSha256'
       AND (g.active_runtime->>'observedAt')::timestamptz<=clock_timestamp() AND clock_timestamp()-(g.active_runtime->>'observedAt')::timestamptz<=interval '30 seconds'
       AND NOT EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.sync_root_id=g.root_id AND j.sync_result IS NULL)
       AND NOT EXISTS(SELECT 1 FROM public.sync_stream_uploads s WHERE s.root_id=g.root_id AND s.state<>'PUBLISHED'))
 ELSE public.catalog_guard_activation_preflight_v1(g) END
$$;
-- A plan is operator-owned evidence, never writable by a device or runtime role.
REVOKE ALL ON sync_migration_plans,sync_migration_progress FROM PUBLIC;

-- Permit only the table owner's verified offline transition, retaining every
-- other predicate of the installed guard. Backup definitions make down exact.
DO $upgrade$ DECLARE definition text; needle text; replacement text; BEGIN
 definition:=pg_get_functiondef('catalog_guard_registration()'::regprocedure);
 needle:='OLD.active_runtime IS NULL AND NEW.active_runtime IS NOT NULL';
 replacement:='(OLD.active_runtime IS NULL OR NEW.active_runtime->>''schema''=''saturn.catalog-active.v2'' AND NEW.active_runtime->>''adoptionPlanId'' IS DISTINCT FROM OLD.active_runtime->>''adoptionPlanId'') AND NEW.active_runtime IS NOT NULL';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'lifecycle guard source mismatch'; END IF; EXECUTE replace(definition,needle,replacement);
 definition:=pg_get_functiondef('catalog_guard_rows()'::regprocedure);
 needle:='OLD.namespace_state=''QUALIFYING'' AND NEW.namespace_state=''ACTIVE''';
 replacement:='OLD.namespace_state IN (''QUALIFYING'',''ACTIVE'',''BACKEND_UNCERTAIN'') AND NEW.namespace_state=''ACTIVE''';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'lifecycle guard source mismatch'; END IF; definition:=replace(definition,needle,replacement);
 needle:='-- Exact offline ACTIVE transition, never a callback/GUC/request permit.';
 replacement:=$metadata$
   -- Verified offline metadata adoption; file bytes were read under a drained
   -- backend and only availability/version initialization is permitted.
   IF TG_TABLE_NAME='resources' AND TG_OP='UPDATE' THEN
     IF current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.resources'::regclass)
       AND NEW.sync_availability='AVAILABLE' AND (to_jsonb(OLD)-ARRAY['sync_availability','metadata_version','updated_at'])=(to_jsonb(NEW)-ARRAY['sync_availability','metadata_version','updated_at'])
       AND EXISTS(SELECT 1 FROM public.sync_migration_plans p JOIN public.sync_migration_progress v ON v.plan_id=p.id AND v.node_id=OLD.id
         WHERE p.root_id=g.root_id AND p.state='VERIFIED' AND p.verified_nodes=p.node_count
           AND v.evidence=jsonb_build_object('id',OLD.id::text,'parent_id',OLD.parent_id::text,'name',OLD.name,'type',OLD.type,'storage_path',OLD.storage_path,
             'size_bytes',OLD.size_bytes::text,'sha256',OLD.sha256,'current_version_id',OLD.current_version_id::text,'metadata_version',OLD.metadata_version::text,'status',OLD.status)
           AND EXISTS(SELECT 1 FROM public.sync_backend_executor b WHERE b.backend_identity=g.backend_identity AND b.state='STOPPED')) THEN CONTINUE; END IF;
   END IF;
   -- Exact offline ACTIVE transition, never a callback/GUC/request permit.
$metadata$;
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'lifecycle guard source mismatch'; END IF; EXECUTE replace(definition,needle,replacement);
END $upgrade$;
CREATE OR REPLACE FUNCTION renew_namespace_binding_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.namespace_state='LEGACY' THEN
   IF TG_OP='UPDATE' AND OLD.namespace_state<>'LEGACY' THEN RAISE EXCEPTION 'Namespace binding cannot silently return to LEGACY' USING ERRCODE='23514'; END IF;
   NEW.binding_version:=NULL;
 ELSIF TG_OP='INSERT' THEN NEW.binding_version:=gen_random_uuid();
 ELSIF ROW(NEW.namespace_state,NEW.descriptor_schema) IS DISTINCT FROM ROW(OLD.namespace_state,OLD.descriptor_schema) THEN NEW.binding_version:=gen_random_uuid();
 ELSIF NEW.binding_version IS DISTINCT FROM OLD.binding_version AND current_user=session_user
   AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.sync_root_clock'::regclass)
   AND EXISTS(SELECT 1 FROM public.catalog_guard_roots g WHERE g.root_id=OLD.root_id AND g.active_runtime->>'schema'='saturn.catalog-active.v2' AND public.catalog_guard_activation_preflight(g))
 THEN NEW.binding_version:=gen_random_uuid();
 ELSE NEW.binding_version:=OLD.binding_version; END IF;
 RETURN NEW;
END $$;
