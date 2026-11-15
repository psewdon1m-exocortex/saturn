-- Restore the exact previous command without changing reserved originals.
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.pg_advisory_xact_lock(1397967206);
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $migration$
DECLARE
  target regprocedure := 'public.catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure;
  helper regprocedure := 'public.catalog_upload_try_reserve_set_v1(jsonb,jsonb)'::regprocedure;
  previous_search_path text := pg_catalog.current_setting('search_path');
  original text;
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  IF EXISTS (SELECT 1 FROM public.sync_backend_executor WHERE state <> 'STOPPED') THEN
    RAISE EXCEPTION 'backend must be stopped before grouped reservation rollback';
  END IF;
  IF encode(sha256(convert_to(replace(pg_get_functiondef(target),E'\r\n',E'\n'),'UTF8')),'hex') <> 'd90027daf805ff3b3eb07d9cb5fe9e3e80e03d7a6c301cc7c224dcee459ff0e4'
    OR encode(sha256(convert_to(replace(pg_get_functiondef(helper),E'\r\n',E'\n'),'UTF8')),'hex') <> '35d93f3f7e4d936d59cdac3a5478448fcd100f9c5766636c053e82a21dd401cd' THEN
    RAISE EXCEPTION 'unexpected grouped reservation definition before rollback 128';
  END IF;
  SELECT definition INTO STRICT original FROM public.sync_extension_function_backup
    WHERE revision=128 AND identity='public.catalog_upload_command(text,jsonb,jsonb,jsonb)';
  IF encode(sha256(convert_to(replace(original,E'\r\n',E'\n'),'UTF8')),'hex') <> '588bd2f5a26812179b9c5a81b7bae94044bcc2e276ee314b2f4092b76df7a239' THEN
    RAISE EXCEPTION 'unexpected catalog command backup for rollback 128';
  END IF;
  EXECUTE original;
  DROP FUNCTION public.catalog_upload_try_reserve_set_v1(jsonb,jsonb);
  DELETE FROM public.sync_extension_function_backup
    WHERE revision=128 AND identity='public.catalog_upload_command(text,jsonb,jsonb,jsonb)';
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END
$migration$;
