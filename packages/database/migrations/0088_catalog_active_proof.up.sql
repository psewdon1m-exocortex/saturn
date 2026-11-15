-- A stored activation proof is immutable and checked at write time. Retain the
-- full format validator for synthetic/offline candidates, and all live binding
-- checks for both paths. No proof or state is cached outside this SQL snapshot.
ALTER TABLE catalog_guard_roots ADD CONSTRAINT catalog_guard_active_proof_checked
 CHECK(active_runtime IS NULL OR catalog_guard_active_shape(active_runtime) IS TRUE);
INSERT INTO sync_extension_function_backup VALUES(88,'catalog_guard_active_valid(catalog_guard_roots)',pg_get_functiondef('catalog_guard_active_valid(catalog_guard_roots)'::regprocedure));
DO $install$
DECLARE definition text; marker text;
BEGIN
 definition:=pg_get_functiondef('catalog_guard_active_valid(catalog_guard_roots)'::regprocedure);
 marker:='SELECT public.catalog_guard_active_shape(g.active_runtime) AND';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'active proof validator predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,$body$SELECT (CASE WHEN EXISTS(
   SELECT 1 FROM public.catalog_guard_roots checked WHERE checked.root_id=g.root_id AND checked.active_runtime=g.active_runtime
 ) THEN true ELSE public.catalog_guard_active_shape(g.active_runtime) END) AND$body$);
END $install$;
