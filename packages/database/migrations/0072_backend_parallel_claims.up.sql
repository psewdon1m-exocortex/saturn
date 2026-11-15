-- One durable owner/fence, up to four nonconflicting effects. Earlier overlapping
-- queued work remains a barrier; UNKNOWN never transfers or releases ownership.
INSERT INTO sync_extension_function_backup VALUES(72,'sync_backend_command(text,jsonb,jsonb)',pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure));
CREATE OR REPLACE FUNCTION sync_backend_command(command text,identity jsonb,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_variable
DECLARE b public.sync_backend_executor%ROWTYPE; t public.sync_backend_tasks%ROWTYPE; h text; used bigint;
BEGIN
 IF jsonb_typeof(identity) IS DISTINCT FROM 'object' OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
   OR octet_length(identity::text)>2048 OR octet_length(payload::text)>11536384 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO b FROM public.sync_backend_executor WHERE backend_identity=identity->>'backendIdentity' FOR UPDATE;
 IF NOT FOUND OR session_user<>b.writer_login OR current_user<>b.writer_owner OR b.generation::text IS DISTINCT FROM identity->>'generation' THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 IF command='read-close' THEN
   IF payload->>'connectionsClosed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'invalid_input'; END IF;
   DELETE FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND client_id=(identity->>'ownerId')::uuid;
   RETURN '{}'::jsonb;
 END IF;
 IF command='read-release' THEN
   DELETE FROM public.sync_backend_read_slots WHERE id=(payload->>'id')::uuid AND backend_identity=b.backend_identity AND client_id=(identity->>'ownerId')::uuid;
   RETURN '{}'::jsonb;
 END IF;
 IF command='read-acquire' THEN
   IF b.state<>'RUNNING' THEN RAISE EXCEPTION 'backend_draining'; END IF;
   IF (SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity)>=128
     AND NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE id=(payload->>'id')::uuid) THEN RAISE EXCEPTION 'capacity'; END IF;
   INSERT INTO public.sync_backend_read_slots(id,backend_identity,generation,client_id,priority,state)
     VALUES((payload->>'id')::uuid,b.backend_identity,b.generation,(identity->>'ownerId')::uuid,payload->>'priority','WAITING') ON CONFLICT(id) DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE id=(payload->>'id')::uuid AND backend_identity=b.backend_identity AND generation=b.generation AND client_id=(identity->>'ownerId')::uuid AND priority=payload->>'priority') THEN RAISE EXCEPTION 'operation_reused'; END IF;
   IF (SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND state='ACTIVE')<4
     AND (payload->>'priority'='foreground' OR NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND priority='scrub' AND state='ACTIVE'))
     -- Four read slots plus up to four disjoint physical effects cap data jobs at eight.
     -- One scrub slot can proceed alongside two foreground readers. Aging
     -- after two seconds gives that slot a bounded opportunity under load.
     AND (payload->>'priority'='scrub' OR NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND priority='scrub' AND state='WAITING' AND created_at<clock_timestamp()-interval '2 seconds')
       OR (SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND state='ACTIVE')<3)
     AND NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots a JOIN public.sync_backend_read_slots mine ON mine.id=(payload->>'id')::uuid
       WHERE a.backend_identity=b.backend_identity AND a.priority=mine.priority AND a.state='WAITING' AND (a.created_at,a.id)<(mine.created_at,mine.id)) THEN
     UPDATE public.sync_backend_read_slots SET state='ACTIVE' WHERE id=(payload->>'id')::uuid;
   END IF;
   RETURN jsonb_build_object('acquired',EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE id=(payload->>'id')::uuid AND state='ACTIVE'));
 END IF;
 IF command='inspect' THEN
   RETURN jsonb_build_object('state',b.state,'ownerId',b.owner_id,'fencingToken',b.fencing_token,'generation',b.generation,
     'queued',(SELECT count(*) FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state='QUEUED'),
     'unknown',(SELECT count(*) FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state='UNKNOWN'),
     'reservedBytes',(SELECT coalesce(sum(reserved_bytes),0)::text FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state IN ('QUEUED','RUNNING','UNKNOWN')),
     'completedEffects',b.completed_effects::text,'writtenBytes',b.written_bytes::text,'copiedBytes',b.copied_bytes::text,'rejectedEffects',b.rejected_effects::text,
     'activeReads',(SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND state='ACTIVE'),
     'waitingReads',(SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND state='WAITING'),
     'diskReserveBytes',b.disk_reserve_bytes::text,'maximumReservedBytes',b.maximum_reserved_bytes::text,
     'oldestPendingAt',(SELECT min(created_at) FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state IN ('QUEUED','RUNNING','UNKNOWN')));
 END IF;
 IF command='acquire' THEN
   IF b.state='STOPPED' AND NOT EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state IN ('RUNNING','UNKNOWN')) THEN
     UPDATE public.sync_backend_executor SET owner_id=(identity->>'ownerId')::uuid,fencing_token=(identity->>'fencingToken')::uuid,state='RUNNING',heartbeat_at=now(),updated_at=now() WHERE backend_identity=b.backend_identity RETURNING * INTO b;
   END IF;
   RETURN jsonb_build_object('owned',b.state='RUNNING' AND b.owner_id::text=identity->>'ownerId' AND b.fencing_token::text=identity->>'fencingToken');
 END IF;
 IF command='submit' THEN
   h:=encode(sha256(convert_to((payload->'body')::text,'UTF8')),'hex');
   SELECT * INTO t FROM public.sync_backend_tasks WHERE id=(payload->>'id')::uuid;
   IF FOUND THEN
     IF t.backend_identity<>b.backend_identity OR t.generation<>b.generation OR t.command IS DISTINCT FROM payload->>'command' OR t.payload_hash<>h THEN RAISE EXCEPTION 'operation_reused'; END IF;
     RETURN jsonb_build_object('id',t.id,'state',t.state,'result',t.result,'errorCode',t.error_code);
   END IF;
   IF b.state<>'RUNNING' THEN RAISE EXCEPTION 'backend_draining'; END IF;
   SELECT coalesce(sum(reserved_bytes),0) INTO used FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state IN ('QUEUED','RUNNING','UNKNOWN');
   IF (SELECT count(*) FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state IN ('QUEUED','RUNNING','UNKNOWN'))>=b.maximum_queued
     OR (payload->>'reservedBytes')::bigint<0 OR used+(payload->>'reservedBytes')::bigint>b.maximum_reserved_bytes THEN RAISE EXCEPTION 'capacity'; END IF;
   IF EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state='UNKNOWN') THEN RAISE EXCEPTION 'reconciliation_required'; END IF;
   INSERT INTO public.sync_backend_tasks(id,backend_identity,generation,command,payload,payload_hash,reserved_bytes)
     VALUES((payload->>'id')::uuid,b.backend_identity,b.generation,payload->>'command',payload->'body',h,(payload->>'reservedBytes')::bigint) RETURNING * INTO t;
   RETURN jsonb_build_object('id',t.id,'state',t.state);
 END IF;
 IF command='status' THEN
   SELECT * INTO t FROM public.sync_backend_tasks WHERE id=(payload->>'id')::uuid AND backend_identity=b.backend_identity AND generation=b.generation;
   IF NOT FOUND THEN RAISE EXCEPTION 'operation_reused'; END IF;
   RETURN jsonb_build_object('id',t.id,'state',t.state,'result',t.result,'errorCode',t.error_code);
 END IF;
 IF b.owner_id::text IS DISTINCT FROM identity->>'ownerId' OR b.fencing_token::text IS DISTINCT FROM identity->>'fencingToken' OR b.state NOT IN ('RUNNING','DRAINING') THEN RAISE EXCEPTION 'backend_draining'; END IF;
 IF command='claim' THEN
   IF EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state='UNKNOWN') OR (SELECT count(*) FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state='RUNNING')>=4 THEN RETURN NULL; END IF;
   SELECT q.* INTO t FROM public.sync_backend_tasks q
     WHERE q.backend_identity=b.backend_identity AND q.generation=b.generation AND q.state='QUEUED'
     AND NOT EXISTS (
       SELECT 1 FROM public.sync_backend_tasks prior WHERE prior.backend_identity=b.backend_identity
         AND (prior.state='RUNNING' OR prior.state='QUEUED' AND (prior.created_at,prior.id)<(q.created_at,q.id))
         AND EXISTS (
           SELECT 1 FROM unnest(ARRAY[q.payload->>'path',q.payload->>'source',q.payload->>'destination']) a(p)
             CROSS JOIN unnest(ARRAY[prior.payload->>'path',prior.payload->>'source',prior.payload->>'destination']) z(p)
           WHERE a.p=z.p OR starts_with(a.p,z.p||'/') OR starts_with(z.p,a.p||'/')
         )
         AND NOT (q.command='write' AND prior.command='write' AND q.payload->>'path'=prior.payload->>'path'
           AND coalesce(q.payload->'options'->>'create','false')='false' AND coalesce(prior.payload->'options'->>'create','false')='false'
           AND coalesce(q.payload->'options'->>'truncate','false')='false' AND coalesce(prior.payload->'options'->>'truncate','false')='false'
           AND ((q.payload->'options'->>'offset')::bigint+q.reserved_bytes<=(prior.payload->'options'->>'offset')::bigint
             OR (prior.payload->'options'->>'offset')::bigint+prior.reserved_bytes<=(q.payload->'options'->>'offset')::bigint))
     ) ORDER BY q.created_at,q.id LIMIT 1 FOR UPDATE;
   UPDATE public.sync_backend_executor SET heartbeat_at=now(),updated_at=now() WHERE backend_identity=b.backend_identity;
   IF NOT FOUND OR t.id IS NULL THEN RETURN NULL; END IF;
   UPDATE public.sync_backend_tasks SET state='RUNNING',owner_id=b.owner_id,fencing_token=b.fencing_token,updated_at=now() WHERE id=t.id;
   RETURN jsonb_build_object('id',t.id,'command',t.command,'body',t.payload,'reservedBytes',t.reserved_bytes::text,'diskReserveBytes',b.disk_reserve_bytes::text);
 END IF;
 IF command IN ('complete','unknown','reject') THEN
   SELECT * INTO t FROM public.sync_backend_tasks WHERE id=(payload->>'id')::uuid AND backend_identity=b.backend_identity FOR UPDATE;
   IF NOT FOUND OR t.owner_id<>b.owner_id OR t.fencing_token<>b.fencing_token OR t.state NOT IN ('RUNNING','DONE','UNKNOWN','REJECTED') THEN RAISE EXCEPTION 'operation_reused'; END IF;
   IF t.state='RUNNING' THEN
     UPDATE public.sync_backend_executor SET completed_effects=completed_effects+CASE WHEN command='complete' THEN 1 ELSE 0 END,
       written_bytes=written_bytes+CASE WHEN command='complete' AND t.command='write' THEN (payload->>'result')::bigint ELSE 0 END,
       copied_bytes=copied_bytes+CASE WHEN command='complete' AND t.command='copy' THEN t.reserved_bytes ELSE 0 END,
       rejected_effects=rejected_effects+CASE WHEN command='reject' THEN 1 ELSE 0 END WHERE backend_identity=b.backend_identity;
     UPDATE public.sync_backend_tasks SET state=CASE command WHEN 'complete' THEN 'DONE' WHEN 'reject' THEN 'REJECTED' ELSE 'UNKNOWN' END,
       result=payload->'result',error_code=payload->>'errorCode',payload=CASE WHEN command IN ('complete','reject') THEN t.payload-'bytes' ELSE t.payload END,updated_at=now() WHERE id=t.id;
   END IF;
   RETURN jsonb_build_object('id',t.id);
 END IF;
 IF command='drain' THEN UPDATE public.sync_backend_executor SET state='DRAINING',updated_at=now() WHERE backend_identity=b.backend_identity; RETURN '{}'::jsonb; END IF;
 IF command='stopped' THEN
   IF payload->>'connectionsClosed' IS DISTINCT FROM 'true' OR EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state IN ('RUNNING','UNKNOWN')) THEN RAISE EXCEPTION 'reconciliation_required'; END IF;
   UPDATE public.sync_backend_executor SET state='STOPPED',owner_id=NULL,fencing_token=NULL,stopped_receipt=jsonb_build_object('ownerId',b.owner_id,'fencingToken',b.fencing_token,'generation',b.generation,'stoppedAt',clock_timestamp(),'connectionsClosed',true),updated_at=now() WHERE backend_identity=b.backend_identity;
   RETURN '{}'::jsonb;
 END IF;
 RAISE EXCEPTION 'invalid_input';
END $$;
