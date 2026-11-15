-- INSERT has no OLD membership or control-aggregate UPDATE exemption. Resolve
-- its complete parent/trashed-parent sets once; UPDATE/DELETE keep row guards.
LOCK TABLE sync_backend_executor,catalog_guard_roots,resources IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before resource set migration'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='resources'::regclass AND tgname='catalog_guard_rows' AND tgenabled='O'
   AND tgfoid='catalog_guard_rows()'::regprocedure AND tgtype=31) THEN RAISE EXCEPTION 'resource row guard prerequisite mismatch'; END IF;
END $$;
CREATE FUNCTION catalog_guard_resource_insert_set() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE parents uuid[]; trashed uuid[]; ids uuid[]; g public.catalog_guard_roots%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.catalog_guard_roots) THEN RETURN NULL; END IF;
 SELECT array_agg(parent_id),array_agg(trashed_from_parent_id) INTO parents,trashed FROM new_rows;
 ids:=public.catalog_guard_scopes(parents,false)||public.catalog_guard_scopes(trashed,true);
 FOR g IN SELECT * FROM public.catalog_guard_roots WHERE root_id=ANY(ids) LOOP
   IF current_user<>g.writer_owner OR session_user<>g.writer_login THEN
     RAISE EXCEPTION 'catalog writer unqualified' USING ERRCODE='42501';
   END IF;
   -- Both existing writer contracts permit resource INSERT. No topology or
   -- caller-supplied permit is cached, and all statement members contribute.
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION catalog_guard_resource_insert_set() FROM PUBLIC;
DROP TRIGGER catalog_guard_rows ON resources;
CREATE TRIGGER catalog_guard_rows BEFORE UPDATE OR DELETE ON resources FOR EACH ROW EXECUTE FUNCTION catalog_guard_rows();
CREATE TRIGGER catalog_guard_resource_insert_set AFTER INSERT ON resources REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION catalog_guard_resource_insert_set();
