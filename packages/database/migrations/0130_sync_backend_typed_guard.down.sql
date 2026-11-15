-- Restore the exact original guard without changing backend state.
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.pg_advisory_xact_lock(1397967206);
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $migration$
DECLARE
  target regprocedure := 'public.sync_extension_write_guard()'::regprocedure;
  original text;
  previous_search_path text := pg_catalog.current_setting('search_path');
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  IF EXISTS (SELECT 1 FROM public.sync_backend_executor WHERE state <> 'STOPPED') THEN
    RAISE EXCEPTION 'backend must be stopped before typed backend guard rollback';
  END IF;
  IF encode(sha256(convert_to(replace(pg_get_functiondef(target),E'\r\n',E'\n'),'UTF8')),'hex') <> '1a76e894aa1e61efe74c2444001528872702187a5cf3a0152ddb10cd08e98695' THEN
    RAISE EXCEPTION 'unexpected backend guard definition before rollback 130';
  END IF;
  SELECT definition INTO STRICT original FROM public.sync_extension_function_backup
    WHERE revision = 130 AND identity = 'public.sync_extension_write_guard()';
  IF encode(sha256(convert_to(replace(original,E'\r\n',E'\n'),'UTF8')),'hex') <> 'ff30c1c5bad3fe0f122f2aab018d124c65b10d758fb13e2f9bf5b1358db505d4' THEN
    RAISE EXCEPTION 'unexpected backend guard backup for rollback 130';
  END IF;
  EXECUTE original;
  DELETE FROM public.sync_extension_function_backup
    WHERE revision = 130 AND identity = 'public.sync_extension_write_guard()';
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END
$migration$;
