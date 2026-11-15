DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM operation_journal WHERE operation_type='folder_revalidate') THEN
  RAISE EXCEPTION 'Used folder revalidation history cannot be rolled back' USING ERRCODE='55000';
 END IF;
END $$;
DROP TRIGGER operation_folder_revalidation_guard ON operation_journal;
ALTER TABLE operation_journal DROP CONSTRAINT operation_folder_revalidation_shape;
DROP FUNCTION catalog_folder_revalidation_command(text,jsonb,jsonb);
DROP FUNCTION guard_catalog_folder_revalidation();
DROP FUNCTION catalog_folder_revalidation_shape(operation_journal);
DROP FUNCTION catalog_folder_revalidation_hash(jsonb);
DROP FUNCTION catalog_folder_revalidation_input(jsonb);
