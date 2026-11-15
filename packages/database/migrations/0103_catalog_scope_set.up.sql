-- Resolve complete transition-table anchor sets in one stable SQL snapshot.
-- Every path still reaches the real root; no ancestor/authority cache is kept.
LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before scope set migration'; END IF;
END $$;
INSERT INTO sync_extension_function_backup SELECT 103,p.oid::regprocedure::text,pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.oid IN (
 'catalog_guard_scope(uuid,boolean)'::regprocedure,'catalog_guard_statement()'::regprocedure);
CREATE FUNCTION catalog_guard_scopes(anchors uuid[],include_controls boolean DEFAULT true) RETURNS uuid[]
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE hit uuid[]; controls uuid[]; invalid boolean;
BEGIN
 IF anchors IS NULL OR cardinality(array_remove(anchors,NULL))=0 OR NOT EXISTS(SELECT 1 FROM public.catalog_guard_roots) THEN RETURN '{}'::uuid[]; END IF;
 WITH RECURSIVE walk AS(
   SELECT a.id,r.parent_id,r.type,0 depth,ARRAY[a.id] visited,false cycle,r.id IS NULL missing
   FROM (SELECT DISTINCT id FROM unnest(anchors) id WHERE id IS NOT NULL) a
   LEFT JOIN public.resources r ON r.id=a.id
   UNION ALL
   SELECT w.parent_id,r.parent_id,r.type,w.depth+1,w.visited||w.parent_id,w.parent_id=ANY(w.visited),r.id IS NULL
   FROM walk w LEFT JOIN public.resources r ON r.id=w.parent_id
   WHERE w.parent_id IS NOT NULL AND NOT w.cycle AND NOT w.missing AND w.depth<131
 )
 SELECT coalesce(array_agg(DISTINCT g.root_id) FILTER(WHERE g.root_id IS NOT NULL),'{}'),
   coalesce(bool_or(w.missing OR w.cycle OR w.depth>130 OR (w.depth>0 AND w.type<>'folder')
     OR (w.parent_id IS NULL AND w.id<>'00000000-0000-7000-8000-000000000001'::uuid)),false)
 INTO hit,invalid FROM walk w LEFT JOIN public.catalog_guard_roots g ON g.root_id=w.id;
 IF invalid THEN RAISE EXCEPTION 'catalog guard membership unproven' USING ERRCODE='55000'; END IF;
 SELECT coalesce(array_agg(root_id),'{}') INTO controls FROM public.catalog_guard_roots
 WHERE root_id=ANY(anchors) OR (include_controls AND control_ancestor_ids&&anchors);
 RETURN ARRAY(SELECT DISTINCT id FROM unnest(hit||controls) id);
END $$;
CREATE OR REPLACE FUNCTION catalog_guard_scope(anchor uuid,include_controls boolean DEFAULT true) RETURNS uuid[]
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$ SELECT public.catalog_guard_scopes(ARRAY[anchor],include_controls) $$;
DO $install$
DECLARE definition text; marker text;
BEGIN
 definition:=pg_get_functiondef('catalog_guard_statement()'::regprocedure);
 marker:=$m$FOR anchor IN SELECT DISTINCT x FROM unnest(coalesce(anchors,'{}')||coalesce(old_anchors,'{}')) x WHERE x IS NOT NULL LOOP ids:=ids||public.catalog_guard_scope(anchor); END LOOP;$m$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'statement anchor set predecessor mismatch'; END IF;
 definition:=replace(definition,marker,$m$ids:=ids||public.catalog_guard_scopes(coalesce(anchors,'{}')||coalesce(old_anchors,'{}'));$m$);
 marker:=$m$FOR anchor IN SELECT DISTINCT x FROM unnest(coalesce(plain_anchors,'{}')||coalesce(old_plain,'{}')) x WHERE x IS NOT NULL LOOP ids:=ids||public.catalog_guard_scope(anchor,false); END LOOP;$m$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'statement plain anchor set predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,$m$ids:=ids||public.catalog_guard_scopes(coalesce(plain_anchors,'{}')||coalesce(old_plain,'{}'),false);$m$);
END $install$;
