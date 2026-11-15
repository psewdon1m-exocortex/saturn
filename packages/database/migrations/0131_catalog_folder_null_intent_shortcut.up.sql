-- A row without a folder intent has neither a folder claim nor an effect.
-- Keep the exact v1 and v2 validation paths for all non-NULL intents.
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.pg_advisory_xact_lock(1397967206);
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $migration$
DECLARE
  target regprocedure := 'public.catalog_folder_shape(public.operation_journal)'::regprocedure;
  original text;
  legacy regprocedure := 'public.catalog_folder_shape_v1(public.operation_journal)'::regprocedure;
  revised text;
  previous_search_path text := pg_catalog.current_setting('search_path');
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  IF EXISTS (SELECT 1 FROM public.sync_backend_executor WHERE state <> 'STOPPED') THEN
    RAISE EXCEPTION 'backend must be stopped before folder null-intent migration';
  END IF;
  original := pg_get_functiondef(target);
  IF encode(sha256(convert_to(replace(original,E'\r\n',E'\n'),'UTF8')),'hex') <> 'd3bad1de1cd440665d31c0dd98a734b3b900c68776f5a796508442459f765a72' THEN
    RAISE EXCEPTION 'unexpected folder shape definition before migration 131';
  END IF;
  IF encode(sha256(convert_to(replace(pg_get_functiondef(legacy),E'\r\n',E'\n'),'UTF8')),'hex') <> '3e38efc0fa50c8a6bd92d044129cabbc1ff67ecf202c25203fd2cd79c5961a79' THEN
    RAISE EXCEPTION 'unexpected legacy folder shape before migration 131';
  END IF;
  revised := replace(replace(original,E'\r\n',E'\n'),
    $old$ IF j.catalog_intent->>'schema' IS DISTINCT FROM 'saturn.catalog-folder-intent.v2' THEN RETURN j.catalog_claim_token IS NULL AND public.catalog_folder_shape_v1(j); END IF;$old$,
    $new$ IF j.catalog_intent IS NULL THEN RETURN j.catalog_claim_token IS NULL AND j.catalog_effect_state IS NULL; END IF;
 IF j.catalog_intent->>'schema' IS DISTINCT FROM 'saturn.catalog-folder-intent.v2' THEN RETURN j.catalog_claim_token IS NULL AND public.catalog_folder_shape_v1(j); END IF;$new$);
  IF encode(sha256(convert_to(replace(revised,E'\r\n',E'\n'),'UTF8')),'hex') <> '6992e05d9eaa9771c54ba9b021918e77fe8c15c72769612d7e039769af6b3307' THEN
    RAISE EXCEPTION 'unexpected revised folder shape definition in migration 131';
  END IF;
  INSERT INTO public.sync_extension_function_backup (revision, identity, definition)
    VALUES (131, 'public.catalog_folder_shape(public.operation_journal)', original);
  EXECUTE revised;
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END
$migration$;
