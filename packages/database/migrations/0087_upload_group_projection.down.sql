DO $restore$
DECLARE saved record;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 IF (SELECT count(*) FROM sync_extension_function_backup WHERE revision=87 AND identity IN ('catalog_upload_command(text,jsonb,jsonb,jsonb)','guard_catalog_upload_group_member()'))<>2 THEN RAISE EXCEPTION 'group projection predecessors missing'; END IF;
 FOR saved IN SELECT definition FROM sync_extension_function_backup WHERE revision=87 ORDER BY identity LOOP EXECUTE saved.definition; END LOOP;
END $restore$;
DELETE FROM sync_extension_function_backup WHERE revision=87;
