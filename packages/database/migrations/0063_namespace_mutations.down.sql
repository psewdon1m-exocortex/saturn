DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM operation_journal WHERE namespace_intent IS NOT NULL) OR EXISTS(SELECT 1 FROM sync_root_policy) THEN
   RAISE EXCEPTION 'Namespace originals and bindings cannot be discarded for rollback';
 END IF;
END $$;
DO $$ DECLARE definition text; BEGIN SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=63 AND identity='renew_resource_metadata_version()'; EXECUTE definition; END $$;
DROP FUNCTION sync_namespace_command(text,jsonb,jsonb,jsonb);
DROP FUNCTION sync_namespace_authorize(uuid,text,jsonb);
DROP FUNCTION sync_namespace_stored(operation_journal);
DROP TRIGGER sync_namespace_original_guard ON operation_journal;
DROP FUNCTION sync_namespace_original_guard();
DROP INDEX resources_authorized_content_lookup;
ALTER TABLE resources DROP COLUMN source_modified_at;
ALTER TABLE operation_journal DROP COLUMN namespace_intent,DROP COLUMN namespace_execution,DROP COLUMN namespace_state,DROP COLUMN namespace_claim_token;
DROP TABLE sync_delete_plans;
DROP TABLE sync_root_policy;
DROP TABLE sync_extension_function_backup;
