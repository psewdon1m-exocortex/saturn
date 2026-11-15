-- Fuse only the first small-file reservation. Recovery uses the explicit 0082
-- token/task mapping; all existing reserve authority/topology/limit gates run.
INSERT INTO sync_extension_function_backup VALUES(83,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=replace(pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:='DECLARE group_item jsonb;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small reserve declaration mismatch'; END IF;
 definition:=replace(definition,marker,'DECLARE small_reserve boolean:=false; small_token uuid; group_item jsonb;');
 marker:=$body$ IF command='verify-claim-group' THEN$body$;
 replacement:=$body$ IF command='reserve-small' THEN
   IF jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
     OR jsonb_typeof(command_payload->'transferToken') IS DISTINCT FROM 'string'
     OR command_payload->>'transferToken' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
     OR jsonb_typeof(input->'intent'->'sizeBytes') IS DISTINCT FROM 'string'
     OR input->'intent'->>'sizeBytes' !~ '^[1-9][0-9]{0,5}$'
     OR (input->'intent'->>'sizeBytes')::numeric>262144 THEN RAISE EXCEPTION 'invalid_input'; END IF;
   small_reserve:=true;small_token:=(command_payload->>'transferToken')::uuid;
   command:='reserve';command_payload:=command_payload-'transferToken';
 END IF;
 IF command='verify-claim-group' THEN$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small reserve entry mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 -- The outer batch accepts this fixed command; ordinary inner reserve validation
 -- checks the remaining exact payload keys and every candidate UUID.
 marker:=$body$batch_item->>'command' NOT IN ('reserve','status'$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small reserve batch mismatch'; END IF;
 definition:=replace(definition,marker,$body$batch_item->>'command' NOT IN ('reserve-small','reserve','status'$body$);
 marker:=$body$i->>'sha256','created',now()+interval '24 hours'$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small reserve session mismatch'; END IF;
 definition:=replace(definition,marker,$body$i->>'sha256',CASE WHEN small_reserve THEN 'uploading' ELSE 'created' END,now()+interval '24 hours'$body$);
 marker:=$body$sync_intent_hash,upload_execution,upload_effect_state)
         VALUES(upload,'upload','created',i->>'idempotencyKey',upload,jsonb_build_object('parentId',p.id,'filename',i->>'name'),i,h,g.root_id,c.epoch,h,e,'transport') RETURNING * INTO j;$body$;
 replacement:=$body$sync_intent_hash,upload_execution,upload_effect_state,upload_transfer,upload_transfer_backend_task)
         VALUES(upload,'upload','created',i->>'idempotencyKey',upload,jsonb_build_object('parentId',p.id,'filename',i->>'name'),i,h,g.root_id,c.epoch,h,e,'transport',
           CASE WHEN small_reserve THEN jsonb_build_object('token',small_token,'offset','0','length',i->>'sizeBytes','originalUploadId',upload) END,
           small_token) RETURNING * INTO j;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small reserve journal mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$IF command='chunk-once' THEN RETURN jsonb_build_object('current',resultj,'transfer',j.upload_transfer); END IF;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'small reserve projection mismatch'; END IF;
 EXECUTE replace(definition,marker,$body$IF command='chunk-once' OR small_reserve THEN RETURN jsonb_build_object('current',resultj,'transfer',j.upload_transfer); END IF;$body$);
END $install$;
CREATE FUNCTION catalog_upload_small_reservation_v1() RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
REVOKE ALL ON FUNCTION catalog_upload_small_reservation_v1() FROM PUBLIC;
