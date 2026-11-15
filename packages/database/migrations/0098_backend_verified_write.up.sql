-- Full small creates can retain an independent physical readback in the same
-- worker slot. Older matching write-once originals remain immutable and readable.
LOCK TABLE sync_backend_executor,sync_backend_tasks IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before verified write migration'; END IF;
END $$;
INSERT INTO sync_extension_function_backup VALUES(98,'sync_backend_command(text,jsonb,jsonb)',pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=replace(pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:=$body$'renameGroup',true);$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'verified write capability predecessor mismatch'; END IF;
 definition:=replace(definition,marker,$body$'renameGroup',true,'writeVerifiedOnce',true);$body$);
 marker:=$body$payload->'body'->>'schema' IS DISTINCT FROM 'saturn.backend-write-once.v1'$body$;
 replacement:=$body$(payload->'body'->>'schema' IS DISTINCT FROM 'saturn.backend-write-once.v1' AND payload->'body'->>'schema' IS DISTINCT FROM 'saturn.backend-write-verified-once.v1')$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'verified write schema predecessor mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$h:=encode(sha256(convert_to(((payload->'body')||jsonb_build_object('payloadRef',(payload->'body'->'payloadRef')-'id'))::text,'UTF8')),'hex');$body$;
 replacement:=$body$IF payload->'body'->>'schema'='saturn.backend-write-verified-once.v1' AND (
       (payload->'body'->'payloadRef'->>'size')::numeric NOT BETWEEN 1 AND 262144
       OR payload->'body'->'options' IS DISTINCT FROM '{"offset":0,"create":true,"exclusive":true,"truncate":false}'::jsonb
     ) THEN RAISE EXCEPTION 'invalid_input'; END IF;
     -- Both requests identify exactly the same write. Never upgrade/rewrite an
     -- existing task body: its numeric legacy receipt requires fresh readback.
     h:=encode(sha256(convert_to(((payload->'body')||jsonb_build_object('schema','saturn.backend-write-once.v1','payloadRef',(payload->'body'->'payloadRef')-'id'))::text,'UTF8')),'hex');$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'verified write identity predecessor mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$IF command='complete' AND t.command='rename-group'$body$;
 replacement:=$body$IF command='complete' AND t.command='write' AND t.payload->>'schema'='saturn.backend-write-verified-once.v1' THEN
     IF jsonb_typeof(payload->'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
     IF (SELECT count(*) FROM jsonb_object_keys(payload->'result'))<>4
       OR payload->'result'->>'schema' IS DISTINCT FROM 'saturn.backend-write-verified-result.v1'
       OR payload->'result'->'sizeBytes' IS DISTINCT FROM t.payload->'payloadRef'->'size'
       OR payload->'result'->'sha256' IS DISTINCT FROM t.payload->'payloadRef'->'sha256'
       OR jsonb_typeof(payload->'result'->'prefixBase64') IS DISTINCT FROM 'string'
       OR length(payload->'result'->>'prefixBase64')>684
       OR length(payload->'result'->>'prefixBase64')%4<>0
       OR payload->'result'->>'prefixBase64' !~ '^[A-Za-z0-9+/]*={0,2}$'
     THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
     IF octet_length(decode(payload->'result'->>'prefixBase64','base64'))<>least((t.payload->'payloadRef'->>'size')::integer,512)
       OR replace(encode(decode(payload->'result'->>'prefixBase64','base64'),'base64'),E'\n','')<>payload->'result'->>'prefixBase64'
     THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
   END IF;
   IF command='complete' AND t.command='rename-group'$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'verified write completion predecessor mismatch'; END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$body$WHEN command='complete' AND t.command='write' THEN (payload->>'result')::bigint$body$;
 replacement:=$body$WHEN command='complete' AND t.command='write' THEN CASE WHEN t.payload->>'schema'='saturn.backend-write-verified-once.v1' THEN (payload->'result'->>'sizeBytes')::bigint ELSE (payload->>'result')::bigint END$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'verified write counter predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
