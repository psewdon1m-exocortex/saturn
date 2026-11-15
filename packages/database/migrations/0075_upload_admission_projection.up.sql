-- Every stored upload already passes operation_catalog_upload_shape on INSERT
-- and UPDATE. Admission needs its state, not a repeated hash/JSON validation of
-- every neighbour at every transition. Keep the original CHECK and classifier.
INSERT INTO sync_extension_function_backup VALUES(75,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='operation_journal'::regclass
   AND conname='operation_catalog_upload_shape' AND contype='c' AND convalidated
   AND pg_get_constraintdef(oid)='CHECK ((catalog_upload_shape(operation_journal.*) IS TRUE))')
 THEN RAISE EXCEPTION 'validated catalog upload shape prerequisite missing'; END IF;
 definition:=pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure);
 marker:='AND NOT public.catalog_upload_transport(x))';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'upload admission predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,'AND NOT coalesce(x.upload_execution IS NOT NULL AND x.upload_effect_state IN (''transport'',''verified''),false))');
END $install$;
CREATE INDEX operation_blocking_catalog_upload ON operation_journal(sync_root_id)
 WHERE sync_result IS NULL AND NOT coalesce(upload_execution IS NOT NULL AND upload_effect_state IN ('transport','verified'),false);
