SELECT pg_advisory_xact_lock(1397967206);
DO $rollback$
DECLARE original text; definition text;
BEGIN
 SELECT b.definition INTO original FROM public.sync_extension_function_backup b
 WHERE b.revision=122 AND b.identity='catalog_upload_private_read(operation_journal)';
 IF original IS NULL THEN RAISE EXCEPTION 'sealed stream private read predecessor missing'; END IF;
 definition:=pg_get_functiondef('public.catalog_upload_private_read(public.operation_journal)'::regprocedure);
 IF position('FROM public.sync_stream_uploads sealed' IN definition)=0 THEN
   RAISE EXCEPTION 'sealed stream private read successor changed';
 END IF;
 EXECUTE original;
 DELETE FROM public.sync_extension_function_backup WHERE revision=122 AND identity='catalog_upload_private_read(operation_journal)';
END $rollback$;
