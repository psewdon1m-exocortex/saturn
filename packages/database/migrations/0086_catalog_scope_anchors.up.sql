-- Resolve the same anchor/control pair only once inside one BEFORE-row trigger.
-- OLD and NEW contribute independently. The original stable ancestry proof and
-- every authorization/control exception remain unchanged; no cache survives.
INSERT INTO sync_extension_function_backup VALUES(86,'catalog_guard_rows()',pg_get_functiondef('catalog_guard_rows()'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=replace(pg_get_functiondef('catalog_guard_rows()'::regprocedure),E'\r\n',E'\n');
 marker:=$body$scoped uuid[]:='{}';$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'scope anchors declaration mismatch'; END IF;
 definition:=replace(definition,marker,$body$anchors uuid[]:='{}'; plain_anchors uuid[]:='{}'; seen uuid[]:='{}'; scope_parent uuid;$body$);
 marker:=$body$ FOREACH row IN ARRAY rows LOOP
   IF TG_TABLE_NAME='resources' THEN
     IF TG_OP<>'INSERT' OR row=to_jsonb(OLD) THEN ids:=ids||public.catalog_guard_scope((row->>'id')::uuid); END IF;
     ids:=ids||public.catalog_guard_scope((row->>'parent_id')::uuid,false);
     ids:=ids||public.catalog_guard_scope((row->>'trashed_from_parent_id')::uuid);
   ELSIF TG_TABLE_NAME='file_versions' THEN ids:=ids||public.catalog_guard_scope((row->>'resource_id')::uuid);
   ELSIF TG_TABLE_NAME='upload_sessions' THEN
     ids:=ids||public.catalog_guard_scope((row->>'parent_id')::uuid)||public.catalog_guard_scope((row->>'resource_id')::uuid)||public.catalog_guard_scope((row->>'overwrite_resource_id')::uuid);
   ELSIF TG_TABLE_NAME='operation_journal' THEN
     IF row->>'sync_root_id' IS NOT NULL THEN ids:=array_append(ids,(row->>'sync_root_id')::uuid); END IF;
     ids:=ids||public.catalog_guard_scope((row->>'resource_id')::uuid);
     IF row->>'upload_id' IS NOT NULL THEN
       SELECT scoped||public.catalog_guard_scope(upload_row.parent_id) INTO scoped FROM public.upload_sessions upload_row WHERE upload_row.id=(row->>'upload_id')::uuid;
       ids:=ids||coalesce(scoped,'{}');
     END IF;
     IF row->'payload'->>'parentId' ~ '^[a-f0-9-]{36}$' THEN
       IF row->>'operation_type'='outside_folder_create' AND row->'payload'->>'schema'='saturn.outside-folder.v1'
         AND row->>'resource_id'=row->'payload'->>'nodeId' AND row->>'sync_root_id' IS NULL AND row->>'upload_id' IS NULL
       THEN ids:=ids||public.catalog_guard_scope((row->'payload'->>'parentId')::uuid,false);
       ELSE ids:=ids||public.catalog_guard_scope((row->'payload'->>'parentId')::uuid); END IF;
     END IF;
   ELSE ids:=array_append(ids,(row->>'root_id')::uuid);
   END IF;
 END LOOP;$body$;
 replacement:=$body$ FOREACH row IN ARRAY rows LOOP
   IF TG_TABLE_NAME='resources' THEN
     IF TG_OP<>'INSERT' OR row=to_jsonb(OLD) THEN anchors:=array_append(anchors,(row->>'id')::uuid); END IF;
     plain_anchors:=array_append(plain_anchors,(row->>'parent_id')::uuid);
     anchors:=array_append(anchors,(row->>'trashed_from_parent_id')::uuid);
   ELSIF TG_TABLE_NAME='file_versions' THEN anchors:=array_append(anchors,(row->>'resource_id')::uuid);
   ELSIF TG_TABLE_NAME='upload_sessions' THEN
     anchors:=anchors||ARRAY[(row->>'parent_id')::uuid,(row->>'resource_id')::uuid,(row->>'overwrite_resource_id')::uuid];
   ELSIF TG_TABLE_NAME='operation_journal' THEN
     IF row->>'sync_root_id' IS NOT NULL THEN ids:=array_append(ids,(row->>'sync_root_id')::uuid); END IF;
     anchors:=array_append(anchors,(row->>'resource_id')::uuid);
     IF row->>'upload_id' IS NOT NULL THEN
       SELECT upload_row.parent_id INTO scope_parent FROM public.upload_sessions upload_row WHERE upload_row.id=(row->>'upload_id')::uuid;
       anchors:=array_append(anchors,scope_parent);
     END IF;
     IF row->'payload'->>'parentId' ~ '^[a-f0-9-]{36}$' THEN
       IF row->>'operation_type'='outside_folder_create' AND row->'payload'->>'schema'='saturn.outside-folder.v1'
         AND row->>'resource_id'=row->'payload'->>'nodeId' AND row->>'sync_root_id' IS NULL AND row->>'upload_id' IS NULL
       THEN plain_anchors:=array_append(plain_anchors,(row->'payload'->>'parentId')::uuid);
       ELSE anchors:=array_append(anchors,(row->'payload'->>'parentId')::uuid); END IF;
     END IF;
   ELSE ids:=array_append(ids,(row->>'root_id')::uuid);
   END IF;
 END LOOP;
 FOREACH id IN ARRAY anchors LOOP
   IF id IS NOT NULL AND NOT(id=ANY(seen)) THEN
     seen:=array_append(seen,id);ids:=ids||public.catalog_guard_scope(id);
   END IF;
 END LOOP;
 seen:='{}';
 FOREACH id IN ARRAY plain_anchors LOOP
   IF id IS NOT NULL AND NOT(id=ANY(seen)) THEN
     seen:=array_append(seen,id);ids:=ids||public.catalog_guard_scope(id,false);
   END IF;
 END LOOP;$body$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'scope anchors body mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
