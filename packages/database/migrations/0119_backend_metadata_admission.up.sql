-- Requires a drained backend; no live ownership/limits are rewritten.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') OR EXISTS(SELECT 1 FROM sync_backend_read_slots) THEN RAISE EXCEPTION 'backend must be stopped before metadata admission upgrade'; END IF;
END $$;
INSERT INTO sync_extension_function_backup VALUES(119,'sync_backend_command(text,jsonb,jsonb)',pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure));
ALTER TABLE sync_backend_read_slots ADD COLUMN kind text NOT NULL DEFAULT 'content' CHECK(kind IN ('content','metadata'));
DO $migration$ DECLARE definition text; old_block text := $old$ IF command='read-acquire' THEN
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
$old$; new_block text := $new$ IF command='read-acquire' THEN
   IF b.state<>'RUNNING' THEN RAISE EXCEPTION 'backend_draining'; END IF;
   IF coalesce(payload->>'kind','content') NOT IN ('content','metadata')
     OR (payload->>'kind'='metadata' AND payload->>'priority' IS DISTINCT FROM 'foreground') THEN RAISE EXCEPTION 'invalid_input'; END IF;
   -- Reserve one waiting slot and one physical slot for short service calls.
   -- Total admission stays 128 queued/active and four active readers.
   IF NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE id=(payload->>'id')::uuid) AND (
     (SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity)>=128
     OR (coalesce(payload->>'kind','content')='content' AND (SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND kind='content')>=127)) THEN RAISE EXCEPTION 'capacity'; END IF;
   INSERT INTO public.sync_backend_read_slots(id,backend_identity,generation,client_id,priority,state,kind)
     VALUES((payload->>'id')::uuid,b.backend_identity,b.generation,(identity->>'ownerId')::uuid,payload->>'priority','WAITING',coalesce(payload->>'kind','content')) ON CONFLICT(id) DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE id=(payload->>'id')::uuid AND backend_identity=b.backend_identity AND generation=b.generation AND client_id=(identity->>'ownerId')::uuid AND priority=payload->>'priority' AND kind=coalesce(payload->>'kind','content')) THEN RAISE EXCEPTION 'operation_reused'; END IF;
   IF (SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND state='ACTIVE')<4
     AND (coalesce(payload->>'kind','content')='metadata' OR (SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND state='ACTIVE' AND kind='content')<3)
     AND (coalesce(payload->>'kind','content')='content' OR NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND state='ACTIVE' AND kind='metadata'))
     AND (payload->>'priority'='foreground' OR NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND priority='scrub' AND state='ACTIVE'))
     AND (payload->>'kind'='metadata' OR payload->>'priority'='scrub' OR NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND priority='scrub' AND state='WAITING' AND created_at<clock_timestamp()-interval '2 seconds')
       OR (SELECT count(*) FROM public.sync_backend_read_slots WHERE backend_identity=b.backend_identity AND state='ACTIVE' AND kind='content')<2)
     AND NOT EXISTS(SELECT 1 FROM public.sync_backend_read_slots a JOIN public.sync_backend_read_slots mine ON mine.id=(payload->>'id')::uuid
       WHERE a.backend_identity=b.backend_identity AND a.kind=mine.kind AND a.priority=mine.priority AND a.state='WAITING' AND (a.created_at,a.id)<(mine.created_at,mine.id)) THEN
     UPDATE public.sync_backend_read_slots SET state='ACTIVE' WHERE id=(payload->>'id')::uuid;
   END IF;
   RETURN jsonb_build_object('acquired',EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE id=(payload->>'id')::uuid AND state='ACTIVE'));
 END IF;
$new$;
BEGIN
 SELECT b.definition INTO STRICT definition FROM sync_extension_function_backup b WHERE revision=119 AND identity='sync_backend_command(text,jsonb,jsonb)';
 IF position(old_block in definition)=0 THEN RAISE EXCEPTION 'backend admission definition unqualified'; END IF;
 EXECUTE replace(definition,old_block,new_block);
END $migration$;
