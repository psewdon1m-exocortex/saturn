-- New files have no old verified row to invalidate. The pre-existing deferred
-- resource->version FK allows one final INSERT, followed by its version INSERT
-- in the same transaction. Overwrites retain their UNKNOWN/AVAILABLE updates.
DO $qualify$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c
   WHERE c.conrelid='resources'::regclass AND c.conname='resources_current_version_fk' AND c.contype='f'
     AND c.confrelid='file_versions'::regclass AND c.condeferrable AND c.condeferred AND c.convalidated
     AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='resources'::regclass AND attname='current_version_id')]
     AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='file_versions'::regclass AND attname='id')])
 THEN RAISE EXCEPTION 'publication needs the qualified deferred version foreign key'; END IF;
END $qualify$;
INSERT INTO sync_extension_function_backup VALUES(85,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=replace(pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:=$body$INSERT INTO public.resources(id,type,parent_id,name,storage_path,mime_type,size_bytes,sha256,status,sync_availability) VALUES(node,'file',p.id,i->>'name',target,command_payload->>'mimeType',u.expected_size,i->>'sha256','active','AVAILABLE');$body$;
 replacement:=$body$INSERT INTO public.resources(id,type,parent_id,name,storage_path,mime_type,size_bytes,sha256,status,sync_availability,current_version_id) VALUES(node,'file',p.id,i->>'name',target,command_payload->>'mimeType',u.expected_size,i->>'sha256','active','AVAILABLE',version) RETURNING * INTO r;$body$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'publication insert marker mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$UPDATE public.resources SET size_bytes=u.expected_size,sha256=i->>'sha256',current_version_id=version,mime_type=command_payload->>'mimeType',updated_at=now() WHERE id=node;
     UPDATE public.resources SET sync_availability='AVAILABLE' WHERE id=node RETURNING * INTO r;$body$;
 replacement:=$body$IF child.id IS NOT NULL THEN
       UPDATE public.resources SET size_bytes=u.expected_size,sha256=i->>'sha256',current_version_id=version,mime_type=command_payload->>'mimeType',updated_at=now() WHERE id=node;
       UPDATE public.resources SET sync_availability='AVAILABLE' WHERE id=node RETURNING * INTO r;
     END IF;$body$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'publication updates marker mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
