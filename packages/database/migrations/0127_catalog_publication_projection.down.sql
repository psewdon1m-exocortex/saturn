-- Restore the exact pre-migration function without changing published data.
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.pg_advisory_xact_lock(1397967206);
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $migration$
DECLARE
  target regprocedure := 'public.catalog_upload_publish_set_v1(jsonb,jsonb)'::regprocedure;
  previous_search_path text := pg_catalog.current_setting('search_path');
  original text;
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  IF EXISTS (SELECT 1 FROM public.sync_backend_executor WHERE state <> 'STOPPED') THEN
    RAISE EXCEPTION 'backend must be stopped before publication projection rollback';
  END IF;
  IF encode(sha256(convert_to(replace(pg_get_functiondef(target),E'\r\n',E'\n'),'UTF8')),'hex') <> 'aebee731ddb3d8a4527e0d5e2b4aee50a546d9e4f11117b7878f868f401e2b44' THEN
    RAISE EXCEPTION 'unexpected grouped publication definition before rollback 127';
  END IF;
  SELECT definition INTO STRICT original FROM public.sync_extension_function_backup
    WHERE revision = 127 AND identity = 'public.catalog_upload_publish_set_v1(jsonb,jsonb)';
  IF encode(sha256(convert_to(replace(original,E'\r\n',E'\n'),'UTF8')),'hex') <> 'be2a942bc2b6139cd6195299b1cdf6a54ecb1dfe10bc57c0e13ce5ea7068f9bd' THEN
    RAISE EXCEPTION 'unexpected grouped publication backup for rollback 127';
  END IF;
  EXECUTE original;
  DELETE FROM public.sync_extension_function_backup
    WHERE revision = 127 AND identity = 'public.catalog_upload_publish_set_v1(jsonb,jsonb)';
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END
$migration$;
