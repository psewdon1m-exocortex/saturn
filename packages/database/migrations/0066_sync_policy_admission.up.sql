-- The old v2 wire remains byte-identical. New roots enforce their selected
-- codec/policy before any reservation can cause physical I/O.
CREATE FUNCTION sync_policy_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
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
 -- A stream's final upload record is the same reservation, not a second job.
 IF TG_TABLE_NAME='operation_journal' AND EXISTS(SELECT 1 FROM public.sync_stream_uploads WHERE operation_id=(to_jsonb(NEW)->>'id')::uuid) THEN RETURN NEW; END IF;
 WITH pending AS (
   SELECT (j.upload_intent->>'sizeBytes')::bigint bytes FROM public.operation_journal j JOIN public.catalog_guard_roots x ON x.root_id=j.sync_root_id
     WHERE x.backend_identity=backend AND j.upload_intent IS NOT NULL AND j.sync_result IS NULL
   UNION ALL SELECT (s.input->'prepare'->'intent'->>'sizeBytes')::bigint FROM public.sync_stream_uploads s JOIN public.catalog_guard_roots x ON x.root_id=s.root_id
     WHERE x.backend_identity=backend AND s.state<>'PUBLISHED' AND NOT EXISTS(SELECT 1 FROM public.operation_journal WHERE id=s.operation_id)
   UNION ALL SELECT (j.namespace_intent->'input'->'source'->>'sizeBytes')::bigint FROM public.operation_journal j JOIN public.catalog_guard_roots x ON x.root_id=j.sync_root_id
     WHERE x.backend_identity=backend AND j.namespace_state<>'PUBLISHED' AND j.namespace_intent->'input'->>'kind'='clone-content'
 ) SELECT coalesce(sum(bytes),0),count(*),count(*) FILTER(WHERE bytes>8388608) INTO total_bytes,jobs,large_jobs FROM pending;
 IF total_bytes+required_bytes>b.maximum_reserved_bytes OR jobs>=4 OR required_bytes>8388608 AND large_jobs>=2 THEN RAISE EXCEPTION 'capacity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_policy_admission BEFORE INSERT ON operation_journal FOR EACH ROW EXECUTE FUNCTION sync_policy_admission();
CREATE TRIGGER sync_policy_admission BEFORE INSERT ON sync_stream_uploads FOR EACH ROW EXECUTE FUNCTION sync_policy_admission();
REVOKE ALL ON FUNCTION sync_policy_admission() FROM PUBLIC;

-- Default privileges on older installations may include runtime table DML.
-- New authority/queue tables must remain protected even on those deployments.
CREATE FUNCTION sync_extension_write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE rowj jsonb; backend text; root uuid; login name; owner_name name;
BEGIN
 IF current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
 END IF;
 IF TG_TABLE_NAME IN ('sync_root_policy','sync_migration_plans','sync_migration_progress','sync_backend_handoffs','sync_extension_function_backup') THEN
   RAISE EXCEPTION 'offline_operator_required' USING ERRCODE='42501';
 END IF;
 rowj:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME IN ('sync_backend_executor','sync_backend_tasks','sync_backend_read_slots') THEN
   backend:=rowj->>'backend_identity';
   SELECT writer_login,writer_owner INTO login,owner_name FROM public.sync_backend_executor WHERE backend_identity=backend;
 ELSE
   root:=(rowj->>'root_id')::uuid;
   SELECT writer_login,writer_owner INTO login,owner_name FROM public.catalog_guard_roots WHERE root_id=root;
 END IF;
 IF login IS NULL OR session_user<>login OR current_user<>owner_name THEN RAISE EXCEPTION 'catalog writer unqualified' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['sync_backend_executor','sync_backend_tasks','sync_backend_read_slots','sync_root_policy','sync_delete_plans','sync_stream_uploads','sync_migration_plans','sync_migration_progress','sync_backend_handoffs','sync_extension_function_backup'] LOOP
   EXECUTE format('CREATE TRIGGER sync_extension_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.sync_extension_write_guard()',table_name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION sync_extension_write_guard() FROM PUBLIC;
