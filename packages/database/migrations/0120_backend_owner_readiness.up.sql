-- Liveness is not custody: an expired heartbeat never transfers ownership.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') OR EXISTS(SELECT 1 FROM sync_backend_read_slots)
 THEN RAISE EXCEPTION 'backend must be stopped before owner readiness upgrade'; END IF;
END $$;
INSERT INTO sync_extension_function_backup VALUES(120,'sync_backend_command(text,jsonb,jsonb)',pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure));
ALTER TABLE sync_backend_executor ADD COLUMN liveness_owner_id uuid, ADD COLUMN liveness_fencing_token uuid, ADD COLUMN liveness_at timestamptz;
DO $migration$ DECLARE definition text;
 anchor text := ' IF command=''read-close'' THEN';
 acquire_anchor text := 'RETURN jsonb_build_object(''owned'',';
 block text := $new$ IF command='readiness' THEN
   IF payload<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_input'; END IF;
   RETURN jsonb_build_object('generation',b.generation,'ready',
     coalesce(b.state='RUNNING' AND b.owner_id=b.liveness_owner_id AND b.fencing_token=b.liveness_fencing_token
       AND b.liveness_at>=clock_timestamp()-interval '15 seconds' AND b.liveness_at<=clock_timestamp()
       AND NOT EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state='UNKNOWN'),false));
 END IF;
 IF command='heartbeat' THEN
   IF payload<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_input'; END IF;
   IF b.state<>'RUNNING' OR b.owner_id::text IS DISTINCT FROM identity->>'ownerId'
     OR b.fencing_token::text IS DISTINCT FROM identity->>'fencingToken' THEN RAISE EXCEPTION 'backend_draining'; END IF;
   UPDATE public.sync_backend_executor SET liveness_owner_id=b.owner_id,liveness_fencing_token=b.fencing_token,liveness_at=clock_timestamp()
     WHERE backend_identity=b.backend_identity;
   RETURN '{}'::jsonb;
 END IF;
$new$;
BEGIN
 SELECT b.definition INTO STRICT definition FROM sync_extension_function_backup b WHERE revision=120 AND identity='sync_backend_command(text,jsonb,jsonb)';
 IF cardinality(string_to_array(definition,anchor))<>2 OR cardinality(string_to_array(definition,acquire_anchor))<>2
 THEN RAISE EXCEPTION 'backend readiness definition unqualified'; END IF;
 definition:=replace(definition,anchor,block||anchor);
 definition:=replace(definition,acquire_anchor,'RETURN jsonb_build_object(''healthHeartbeat'',true,''owned'',');
 EXECUTE definition;
END $migration$;
