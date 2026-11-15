LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $restore$
DECLARE table_name text; trigger_name text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before statement guard rollback'; END IF;
 FOREACH table_name IN ARRAY ARRAY['file_versions','upload_sessions','operation_journal','sync_root_changes','catalog_upload_publication_groups'] LOOP
   trigger_name:=CASE WHEN table_name='catalog_upload_publication_groups' THEN 'catalog_upload_group_writer_guard' ELSE 'catalog_guard_rows' END;
   EXECUTE format('DROP TRIGGER catalog_guard_insert_set ON public.%I',table_name);
   EXECUTE format('DROP TRIGGER catalog_guard_update_set ON public.%I',table_name);
   EXECUTE format('DROP TRIGGER %I ON public.%I',trigger_name,table_name);
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.catalog_guard_rows()',trigger_name,table_name);
 END LOOP;
END $restore$;
DROP FUNCTION catalog_guard_statement();
