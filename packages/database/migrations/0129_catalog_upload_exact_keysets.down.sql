-- Restore the exact previous validators without changing upload data.
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.pg_advisory_xact_lock(1397967206);
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $migration$
DECLARE
  rule record;
  target regprocedure;
  original text;
  previous_search_path text := pg_catalog.current_setting('search_path');
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  IF EXISTS (SELECT 1 FROM public.sync_backend_executor WHERE state <> 'STOPPED') THEN
    RAISE EXCEPTION 'backend must be stopped before upload keyset rollback';
  END IF;
  FOR rule IN SELECT * FROM (VALUES
    ('public.catalog_upload_intent_valid(jsonb)', 'e216f0c57eb0663d1b321d878be903c1731abf83d2f87142d4dfe89ec243fdd2', '9ef0131caa8ae1ad4bd80b3901ccce8a9b7c282afdd45d9247a7c1fea24c9579'),
    ('public.catalog_upload_shape(public.operation_journal)', 'f2ff6bfbb8235a79499b177e74d9f25bfdfb5517bbcb2055997abf55ba511336', 'f1da5e752739f05500df4689ece9716133fa08ef7c9d5862ac6471f75442b8dd')
  ) AS expected(identity, old_hash, new_hash)
  LOOP
    target := rule.identity::regprocedure;
    IF encode(sha256(convert_to(replace(pg_get_functiondef(target),E'\r\n',E'\n'),'UTF8')),'hex') <> rule.new_hash THEN
      RAISE EXCEPTION 'unexpected upload validator definition before rollback 129: %', rule.identity;
    END IF;
    SELECT definition INTO STRICT original FROM public.sync_extension_function_backup
      WHERE revision = 129 AND identity = rule.identity;
    IF encode(sha256(convert_to(replace(original,E'\r\n',E'\n'),'UTF8')),'hex') <> rule.old_hash THEN
      RAISE EXCEPTION 'unexpected upload validator backup for rollback 129: %', rule.identity;
    END IF;
    EXECUTE original;
  END LOOP;
  DELETE FROM public.sync_extension_function_backup WHERE revision = 129;
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END
$migration$;
