-- R05: share only the invoker writer-scope proof across one SQL statement.
-- These tables do not mutate resources/topology. Resource and clock guards,
-- device/epoch/CAS checks, per-row shapes and deferred constraints stay intact.
-- DELETE retains its BEFORE guard (including cascades and disappearing anchors).
LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before statement guard migration'; END IF;
END $$;

CREATE FUNCTION catalog_guard_statement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE ids uuid[]:='{}'; anchors uuid[]:='{}'; plain_anchors uuid[]:='{}'; old_ids uuid[]; old_anchors uuid[]; old_plain uuid[]; anchor uuid; g public.catalog_guard_roots%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.catalog_guard_roots) THEN RETURN NULL; END IF;
 IF TG_OP NOT IN ('INSERT','UPDATE') THEN RAISE EXCEPTION 'unsupported statement guard operation'; END IF;
 -- Static queries retain PostgreSQL's plans; each complete transition relation
 -- contributes its anchors before deduplication, including all OLD aliases.
 IF TG_TABLE_NAME='upload_sessions' THEN
   SELECT array_agg(resource_id)||array_agg(parent_id)||array_agg(overwrite_resource_id) INTO anchors FROM new_rows;
   IF TG_OP='UPDATE' THEN SELECT array_agg(resource_id)||array_agg(parent_id)||array_agg(overwrite_resource_id) INTO old_anchors FROM old_rows; END IF;
 ELSIF TG_TABLE_NAME='file_versions' THEN
   SELECT array_agg(resource_id) INTO anchors FROM new_rows;
   IF TG_OP='UPDATE' THEN SELECT array_agg(resource_id) INTO old_anchors FROM old_rows; END IF;
 ELSIF TG_TABLE_NAME='operation_journal' THEN
   SELECT array_agg(n.sync_root_id),array_agg(n.resource_id)||array_agg(u.parent_id)||array_agg(a.parent) FILTER(WHERE NOT a.outside),
     array_agg(a.parent) FILTER(WHERE a.outside) INTO ids,anchors,plain_anchors
   FROM new_rows n LEFT JOIN public.upload_sessions u ON u.id=n.upload_id CROSS JOIN LATERAL (
     SELECT CASE WHEN n.payload->>'parentId' ~ '^[a-f0-9-]{36}$' THEN (n.payload->>'parentId')::uuid END parent,
       coalesce(n.operation_type='outside_folder_create' AND n.payload->>'schema'='saturn.outside-folder.v1'
         AND n.resource_id::text=n.payload->>'nodeId' AND n.sync_root_id IS NULL AND n.upload_id IS NULL,false) outside) a;
   IF TG_OP='UPDATE' THEN
     SELECT array_agg(n.sync_root_id),array_agg(n.resource_id)||array_agg(u.parent_id)||array_agg(a.parent) FILTER(WHERE NOT a.outside),
       array_agg(a.parent) FILTER(WHERE a.outside) INTO old_ids,old_anchors,old_plain
     FROM old_rows n LEFT JOIN public.upload_sessions u ON u.id=n.upload_id CROSS JOIN LATERAL (
       SELECT CASE WHEN n.payload->>'parentId' ~ '^[a-f0-9-]{36}$' THEN (n.payload->>'parentId')::uuid END parent,
         coalesce(n.operation_type='outside_folder_create' AND n.payload->>'schema'='saturn.outside-folder.v1'
           AND n.resource_id::text=n.payload->>'nodeId' AND n.sync_root_id IS NULL AND n.upload_id IS NULL,false) outside) a;
   END IF;
 ELSIF TG_TABLE_NAME IN ('sync_root_changes','catalog_upload_publication_groups') THEN
   SELECT array_agg(root_id) INTO ids FROM new_rows;
   IF TG_OP='UPDATE' THEN SELECT array_agg(root_id) INTO old_ids FROM old_rows; END IF;
 ELSE RAISE EXCEPTION 'unsupported statement guard table'; END IF;
 ids:=coalesce(ids,'{}')||coalesce(old_ids,'{}');
 -- The same stable scope predicate as the row guard: no rights cache, client
 -- proof, SECURITY DEFINER, GUC, or weakening of OLD membership. Qualified
 -- commands retain their root/authority/topology locks for this transaction.
 FOR anchor IN SELECT DISTINCT x FROM unnest(coalesce(anchors,'{}')||coalesce(old_anchors,'{}')) x WHERE x IS NOT NULL LOOP ids:=ids||public.catalog_guard_scope(anchor); END LOOP;
 FOR anchor IN SELECT DISTINCT x FROM unnest(coalesce(plain_anchors,'{}')||coalesce(old_plain,'{}')) x WHERE x IS NOT NULL LOOP ids:=ids||public.catalog_guard_scope(anchor,false); END LOOP;
 FOR g IN SELECT * FROM public.catalog_guard_roots WHERE root_id=ANY(ids) LOOP
   IF current_user<>g.writer_owner OR session_user<>g.writer_login THEN
     RAISE EXCEPTION 'catalog writer unqualified' USING ERRCODE='42501';
   END IF;
   IF g.writer_contract='folder-only-g1.v1' AND TG_TABLE_NAME NOT IN ('operation_journal','sync_root_changes') THEN
     RAISE EXCEPTION 'catalog writer path unsupported' USING ERRCODE='42501';
   END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION catalog_guard_statement() FROM PUBLIC;

DO $install$
DECLARE table_name text; trigger_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['file_versions','upload_sessions','operation_journal','sync_root_changes','catalog_upload_publication_groups'] LOOP
   trigger_name:=CASE WHEN table_name='catalog_upload_publication_groups' THEN 'catalog_upload_group_writer_guard' ELSE 'catalog_guard_rows' END;
   EXECUTE format('DROP TRIGGER %I ON public.%I',trigger_name,table_name);
   EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.catalog_guard_rows()',trigger_name,table_name);
   EXECUTE format('CREATE TRIGGER catalog_guard_insert_set AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_guard_statement()',table_name);
   EXECUTE format('CREATE TRIGGER catalog_guard_update_set AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_guard_statement()',table_name);
 END LOOP;
END $install$;
