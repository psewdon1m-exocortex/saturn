LOCK TABLE sync_backend_executor,catalog_guard_roots,resources IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before resource set rollback'; END IF;
END $$;
DROP TRIGGER catalog_guard_resource_insert_set ON resources;
DROP TRIGGER catalog_guard_rows ON resources;
CREATE TRIGGER catalog_guard_rows BEFORE INSERT OR UPDATE OR DELETE ON resources FOR EACH ROW EXECUTE FUNCTION catalog_guard_rows();
DROP FUNCTION catalog_guard_resource_insert_set();
