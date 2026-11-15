-- Never restore the defective reader while any v2 original remains retained.
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $rollback$
DECLARE definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM public.sync_stream_uploads WHERE input->>'schema'='saturn.stream-upload.v2')
   OR EXISTS(SELECT 1 FROM public.sync_backend_executor WHERE state<>'STOPPED') THEN
   RAISE EXCEPTION 'retained v2 state prevents projection rollback';
 END IF;
 SELECT b.definition INTO STRICT definition FROM public.sync_extension_function_backup b
 WHERE b.revision=111 AND b.identity='sync_stream_command(text,jsonb,jsonb,jsonb)';
 EXECUTE definition;
 DELETE FROM public.sync_extension_function_backup WHERE revision=111;
END $rollback$;
