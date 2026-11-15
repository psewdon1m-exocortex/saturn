DO $restore$
DECLARE function_identity text; definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 FOREACH function_identity IN ARRAY ARRAY['catalog_upload_command(text,jsonb,jsonb,jsonb)','guard_catalog_upload_execution()'] LOOP
   SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE b.revision=79 AND b.identity=function_identity;
   IF definition IS NULL THEN RAISE EXCEPTION 'atomic claim predecessor missing'; END IF;
   EXECUTE definition;
 END LOOP;
END $restore$;
DELETE FROM sync_extension_function_backup WHERE revision=79;
