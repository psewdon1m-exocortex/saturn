DO $$ BEGIN IF EXISTS(SELECT 1 FROM sync_root_policy) THEN RAISE EXCEPTION 'Policy admission cannot be removed from enrolled roots'; END IF; END $$;
DROP TRIGGER sync_policy_admission ON sync_stream_uploads;
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['sync_backend_executor','sync_backend_tasks','sync_backend_read_slots','sync_root_policy','sync_delete_plans','sync_stream_uploads','sync_migration_plans','sync_migration_progress','sync_backend_handoffs','sync_extension_function_backup'] LOOP
   EXECUTE format('DROP TRIGGER sync_extension_write_guard ON public.%I',table_name);
 END LOOP;
END $$;
DROP FUNCTION sync_extension_write_guard();
DROP TRIGGER sync_policy_admission ON operation_journal;
DROP FUNCTION sync_policy_admission();
