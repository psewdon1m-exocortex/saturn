-- Additive, inactive until explicitly enrolled by the offline lifecycle CLI.
-- No expiry grants ownership. A crashed owner requires an external fencing proof.
CREATE TABLE sync_backend_executor (
 backend_identity text PRIMARY KEY, generation uuid NOT NULL, owner_id uuid, fencing_token uuid,
 state text NOT NULL DEFAULT 'STOPPED' CHECK(state IN ('STOPPED','RUNNING','DRAINING','UNKNOWN')),
 writer_login name NOT NULL, writer_owner name NOT NULL,
 maximum_queued integer NOT NULL DEFAULT 128 CHECK(maximum_queued BETWEEN 1 AND 128),
 maximum_reserved_bytes bigint NOT NULL DEFAULT 1073741824 CHECK(maximum_reserved_bytes>0),
 disk_reserve_bytes bigint NOT NULL DEFAULT 268435456 CHECK(disk_reserve_bytes>=0),
 completed_effects bigint NOT NULL DEFAULT 0,written_bytes bigint NOT NULL DEFAULT 0,copied_bytes bigint NOT NULL DEFAULT 0,rejected_effects bigint NOT NULL DEFAULT 0,
 stopped_receipt jsonb, heartbeat_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((owner_id IS NULL)=(fencing_token IS NULL))
);
CREATE TABLE sync_backend_tasks (
 id uuid PRIMARY KEY, backend_identity text NOT NULL REFERENCES sync_backend_executor(backend_identity),
 generation uuid NOT NULL, command text NOT NULL CHECK(command IN ('write','truncate','mkdir','rename','copy','delete')),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=11534336), payload_hash text NOT NULL,
 reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','DONE','UNKNOWN','REJECTED')),
 owner_id uuid, fencing_token uuid, result jsonb, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_backend_tasks_queue ON sync_backend_tasks(backend_identity,created_at,id) WHERE state='QUEUED';
CREATE INDEX sync_backend_tasks_pending ON sync_backend_tasks(backend_identity,state) WHERE state IN ('QUEUED','RUNNING','UNKNOWN');
CREATE TABLE sync_backend_read_slots (
 id uuid PRIMARY KEY,backend_identity text NOT NULL REFERENCES sync_backend_executor(backend_identity),generation uuid NOT NULL,
 client_id uuid NOT NULL,priority text NOT NULL CHECK(priority IN ('foreground','scrub')),state text NOT NULL CHECK(state IN ('WAITING','ACTIVE')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION sync_backend_command(command text,identity jsonb,payload jsonb) RETURNS jsonb
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
   IF (SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND state='ACTIVE')<3
     AND (payload->>'priority'='foreground' OR NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND priority='scrub' AND state='ACTIVE'))
     -- Three read slots plus the single physical writer cap data jobs at four.
     -- One scrub slot can proceed alongside two foreground readers. Aging
     -- after two seconds gives that slot a bounded opportunity under load.
     AND (payload->>'priority'='scrub' OR NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND priority='scrub' AND state='WAITING' AND created_at<clock_timestamp()-interval '2 seconds')
       OR (SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND state='ACTIVE')<2)
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
   IF EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state IN ('RUNNING','UNKNOWN')) THEN RETURN NULL; END IF;
   SELECT * INTO t FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND generation=b.generation AND state='QUEUED' ORDER BY created_at,id LIMIT 1 FOR UPDATE;
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
REVOKE ALL ON sync_backend_executor,sync_backend_tasks,sync_backend_read_slots FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_backend_command(text,jsonb,jsonb) FROM PUBLIC;
