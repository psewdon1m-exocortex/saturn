-- Replay of a known transfer task may carry a fresh spool reference, but must
-- retain the exact path/options/content digest. Only the first sealed reference
-- is executed; DONE/RUNNING/UNKNOWN originals are never replaced or requeued.
INSERT INTO sync_extension_function_backup VALUES(81,'sync_backend_command(text,jsonb,jsonb)',pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=replace(pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:=$body$RETURN jsonb_build_object('owned',b.state='RUNNING' AND b.owner_id::text=identity->>'ownerId' AND b.fencing_token::text=identity->>'fencingToken');$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'write-once capability marker mismatch'; END IF;
 definition:=replace(definition,marker,$body$RETURN jsonb_build_object('owned',b.state='RUNNING' AND b.owner_id::text=identity->>'ownerId' AND b.fencing_token::text=identity->>'fencingToken','writeOnce',true);$body$);
 marker:=$body$IF command='submit' THEN
   h:=encode(sha256(convert_to((payload->'body')::text,'UTF8')),'hex');$body$;
 replacement:=$body$IF command IN ('submit','submit-once') THEN
   IF command='submit-once' THEN
     IF (SELECT count(*) FROM jsonb_object_keys(payload))<>4 OR NOT payload ?& ARRAY['id','command','body','reservedBytes']
       OR payload->>'command' IS DISTINCT FROM 'write'
       OR jsonb_typeof(payload->'id') IS DISTINCT FROM 'string' OR payload->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
       OR jsonb_typeof(payload->'body') IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(payload->'body'))<>4 OR NOT payload->'body' ?& ARRAY['schema','path','options','payloadRef']
       OR payload->'body'->>'schema' IS DISTINCT FROM 'saturn.backend-write-once.v1'
       OR jsonb_typeof(payload->'body'->'path') IS DISTINCT FROM 'string' OR octet_length(payload->'body'->>'path') NOT BETWEEN 1 AND 32768
       OR jsonb_typeof(payload->'body'->'options') IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(payload->'body'->'options'))<>4 OR NOT payload->'body'->'options' ?& ARRAY['offset','create','exclusive','truncate']
       OR jsonb_typeof(payload->'body'->'options'->'offset') IS DISTINCT FROM 'number' OR payload->'body'->'options'->>'offset' !~ '^(0|[1-9][0-9]{0,15})$'
       OR (payload->'body'->'options'->>'offset')::numeric>9007199254740991
       OR jsonb_typeof(payload->'body'->'options'->'create') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(payload->'body'->'options'->'exclusive') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(payload->'body'->'options'->'truncate') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(payload->'body'->'payloadRef') IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(payload->'body'->'payloadRef'))<>3 OR NOT payload->'body'->'payloadRef' ?& ARRAY['id','size','sha256']
       OR jsonb_typeof(payload->'body'->'payloadRef'->'id') IS DISTINCT FROM 'string' OR payload->'body'->'payloadRef'->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
       OR jsonb_typeof(payload->'body'->'payloadRef'->'size') IS DISTINCT FROM 'string' OR payload->'body'->'payloadRef'->>'size' !~ '^(0|[1-9][0-9]{0,6})$'
       OR (payload->'body'->'payloadRef'->>'size')::numeric>4194304
       OR jsonb_typeof(payload->'body'->'payloadRef'->'sha256') IS DISTINCT FROM 'string' OR payload->'body'->'payloadRef'->>'sha256' !~ '^[a-f0-9]{64}$'
       OR jsonb_typeof(payload->'reservedBytes') IS DISTINCT FROM 'string' OR payload->>'reservedBytes' IS DISTINCT FROM payload->'body'->'payloadRef'->>'size'
       OR (payload->'body'->'options'->>'offset')::numeric+(payload->>'reservedBytes')::numeric>9007199254740991
     THEN RAISE EXCEPTION 'invalid_input'; END IF;
     h:=encode(sha256(convert_to(((payload->'body')||jsonb_build_object('payloadRef',(payload->'body'->'payloadRef')-'id'))::text,'UTF8')),'hex');
   ELSE
     h:=encode(sha256(convert_to((payload->'body')::text,'UTF8')),'hex');
   END IF;$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'write-once submission marker mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
