DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM catalog_guard_roots) THEN RAISE EXCEPTION 'Catalog guard retirement and replay fencing required before downgrade' USING ERRCODE='55000'; END IF;
END $$;
DROP INDEX operation_sync_unresolved_read_admission;
DROP FUNCTION catalog_folder_command(text,jsonb,jsonb);
DROP FUNCTION catalog_folder_hash(jsonb);
DROP TRIGGER catalog_guard_device_binding ON devices;
DROP FUNCTION catalog_guard_device_binding();
DO $$ DECLARE t text; ns text:=current_schema(); BEGIN
 FOREACH t IN ARRAY ARRAY['resources','file_versions','upload_sessions','operation_journal','sync_root_clock','sync_root_changes'] LOOP
   EXECUTE format('DROP TRIGGER catalog_guard_rows ON %I.%I',ns,t);
   EXECUTE format('DROP TRIGGER catalog_guard_truncate ON %I.%I',ns,t);
 END LOOP;
END $$;
DROP TABLE catalog_guard_roots;
DROP FUNCTION catalog_guard_registration();
DROP FUNCTION catalog_guard_truncate();
DROP FUNCTION catalog_guard_rows();
DROP FUNCTION catalog_guard_scope(uuid,boolean);
