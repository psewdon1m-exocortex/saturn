-- Restore the exact original folder validator without touching journal rows.
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.pg_advisory_xact_lock(1397967206);
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $migration$
DECLARE
  target regprocedure := 'public.catalog_folder_shape(public.operation_journal)'::regprocedure;
  original text;
  previous_search_path text := pg_catalog.current_setting('search_path');
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  IF EXISTS (SELECT 1 FROM public.sync_backend_executor WHERE state <> 'STOPPED') THEN
    RAISE EXCEPTION 'backend must be stopped before folder null-intent rollback';
  END IF;
  IF encode(sha256(convert_to(replace(pg_get_functiondef(target),E'\r\n',E'\n'),'UTF8')),'hex') <> '6992e05d9eaa9771c54ba9b021918e77fe8c15c72769612d7e039769af6b3307' THEN
    RAISE EXCEPTION 'unexpected folder shape definition before rollback 131';
  END IF;
  SELECT definition INTO STRICT original FROM public.sync_extension_function_backup
    WHERE revision = 131 AND identity = 'public.catalog_folder_shape(public.operation_journal)';
  IF encode(sha256(convert_to(replace(original,E'\r\n',E'\n'),'UTF8')),'hex') <> 'd3bad1de1cd440665d31c0dd98a734b3b900c68776f5a796508442459f765a72' THEN
    RAISE EXCEPTION 'unexpected folder shape backup for rollback 131';
  END IF;
  EXECUTE original;
  DELETE FROM public.sync_extension_function_backup
    WHERE revision = 131 AND identity = 'public.catalog_folder_shape(public.operation_journal)';
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END
$migration$;
