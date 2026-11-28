-- Migration126 proposal: root-local retention seeding; no authority/grant changes.
-- Preserve SQL68 qualification, exact scope, >=11 active-version threshold and upsert.
CREATE OR REPLACE FUNCTION sync_retention_schedule_root() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.active_runtime IS NOT NULL AND EXISTS(SELECT 1 FROM public.sync_root_policy WHERE root_id=NEW.root_id)
   AND EXISTS(SELECT 1 FROM public.devices WHERE sync_root_id=NEW.root_id AND device_kind='pluto') THEN
   WITH RECURSIVE subtree(id,type) AS (
     SELECT r.id,r.type FROM public.resources r WHERE r.id=NEW.root_id
     UNION
     SELECT r.id,r.type FROM public.resources r JOIN subtree p ON r.parent_id=p.id
   ), candidates AS MATERIALIZED (
     SELECT r.id FROM subtree r WHERE r.type='file'
       AND EXISTS(SELECT 1 FROM public.file_versions v WHERE v.resource_id=r.id AND v.state='active' OFFSET 10 LIMIT 1)
   )
   INSERT INTO public.sync_retention_work(root_id,resource_id)
     SELECT NEW.root_id,r.id FROM candidates r WHERE public.catalog_guard_scope(r.id,false)=ARRAY[NEW.root_id]
     ON CONFLICT(resource_id) DO UPDATE SET requested_at=now();
 END IF;
 RETURN NEW;
END $$;
