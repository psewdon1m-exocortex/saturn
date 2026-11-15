-- Inactive transport registry. No grants, capability changes, root activation,
-- namespace effects or replacement of the original upload journal/receipts.
CREATE TABLE sync_small_batch_budget (
 root_id uuid PRIMARY KEY REFERENCES catalog_guard_roots(root_id),
 operation_count bigint NOT NULL CHECK(operation_count BETWEEN 0 AND 1000000),
 batch_count bigint NOT NULL CHECK(batch_count BETWEEN 0 AND 1000000),
 metadata_bytes bigint NOT NULL CHECK(metadata_bytes BETWEEN 0 AND 2147483647)
);
CREATE TABLE sync_small_batch_operations (
 id uuid PRIMARY KEY,
 operation_key text NOT NULL UNIQUE CHECK(length(operation_key) BETWEEN 8 AND 128),
 root_id uuid NOT NULL REFERENCES catalog_guard_roots(root_id),
 device_id uuid NOT NULL REFERENCES devices(id),
 declaration jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_small_batch_operations_root ON sync_small_batch_operations(root_id,id);
CREATE TABLE sync_small_batches (
 id uuid PRIMARY KEY,
 root_id uuid NOT NULL REFERENCES catalog_guard_roots(root_id),
 device_id uuid NOT NULL REFERENCES devices(id),
 batch_key text NOT NULL CHECK(length(batch_key) BETWEEN 1 AND 128),
 plan jsonb NOT NULL CHECK(octet_length(plan::text)<=4194304),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(root_id,device_id,batch_key)
);

DO $install$ BEGIN EXECUTE replace($ddl$
CREATE FUNCTION sync_small_batch_binding(b jsonb) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text;
BEGIN
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>7
  OR NOT b ?& ARRAY['protocol','descriptor_schema','server_identity','root_id','server_epoch','policy_version','binding_version']
  OR b->>'protocol' IS DISTINCT FROM 'neptune-sync/1' OR b->>'descriptor_schema' IS DISTINCT FROM 'saturn.current-namespace.v1'
  OR EXISTS(SELECT 1 FROM jsonb_each(b) WHERE jsonb_typeof(value)<>'string') THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['root_id','server_epoch','binding_version'] LOOP
  IF b->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 RETURN b->>'server_identity' ~ '^[!-~]{1,128}$' AND b->>'policy_version' ~ '^[!-~]{1,128}$';
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION sync_small_batch_plan_valid(p jsonb) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE m jsonb; b jsonb; e jsonb; i jsonb; v jsonb; c jsonb; k text; n integer:=0; total bigint:=0;
 seen text[]:='{}'; destinations jsonb:='[]'; destination jsonb;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>4194304
  OR (SELECT count(*) FROM jsonb_object_keys(p))<>2 OR NOT p ?& ARRAY['manifest','inputs'] THEN RETURN false; END IF;
 m:=p->'manifest';
 IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(m))<>11
  OR NOT m ?& ARRAY['protocol','descriptor_schema','server_identity','root_id','server_epoch','policy_version','binding_version','schema','batch_id','rules_version','items']
  OR m->>'schema' IS DISTINCT FROM 'saturn.small-file-batch.v1'
  OR jsonb_typeof(m->'batch_id') IS DISTINCT FROM 'string' OR m->>'batch_id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR jsonb_typeof(m->'rules_version') IS DISTINCT FROM 'string' OR m->>'rules_version' !~ '^[!-~]{1,128}$'
  OR jsonb_typeof(m->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(m->'items') NOT BETWEEN 1 AND 500
  OR jsonb_typeof(p->'inputs') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'inputs')<>jsonb_array_length(m->'items') THEN RETURN false; END IF;
 b:=m-ARRAY['schema','batch_id','rules_version','items'];
 IF NOT public.sync_small_batch_binding(b) THEN RETURN false; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(m->'items') LOOP
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(e))<>8
   OR NOT e ?& ARRAY['operation_id','source_generation','source_identity','parent_id','name','size_bytes','sha256','expected']
   OR EXISTS(SELECT 1 FROM jsonb_each(e) WHERE key<>'expected' AND jsonb_typeof(value)<>'string')
   OR e->>'operation_id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' OR e->>'operation_id'=ANY(seen)
   OR e->>'source_identity' !~ '^[!-~]{1,128}$'
   OR e->>'source_generation' !~ '^[1-9][0-9]{0,18}$' OR (e->>'source_generation')::numeric>9223372036854775807
   OR e->>'size_bytes' !~ '^(0|[1-9][0-9]{0,5})$' OR (e->>'size_bytes')::integer>262144
   OR e->>'sha256' !~ '^[a-f0-9]{64}$'
   OR (e->>'size_bytes'='0' AND e->>'sha256'<>'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') THEN RETURN false; END IF;
  seen:=array_append(seen,e->>'operation_id'); total:=total+(e->>'size_bytes')::bigint;
  IF total>33554432 THEN RETURN false; END IF;
  destination:=jsonb_build_array(e->>'parent_id',e->>'name');
  IF destinations @> jsonb_build_array(destination) THEN RETURN false; END IF;
  destinations:=destinations||jsonb_build_array(destination);
  v:=p->'inputs'->n; n:=n+1;
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>4
   OR NOT v ?& ARRAY['epoch','bindingVersion','backendIdentity','intent']
   OR v->>'epoch' IS DISTINCT FROM b->>'server_epoch' OR v->>'bindingVersion' IS DISTINCT FROM b->>'binding_version'
   OR jsonb_typeof(v->'backendIdentity') IS DISTINCT FROM 'string' OR v->>'backendIdentity' !~ '^[A-Za-z0-9._:-]{1,128}$' THEN RETURN false; END IF;
  i:=v->'intent'; c:=i->'condition';
  IF NOT public.catalog_upload_intent_valid(i) OR i->>'schema' IS DISTINCT FROM 'saturn.upload-intent.v2'
   OR i->>'rootId' IS DISTINCT FROM b->>'root_id' OR i->>'idempotencyKey' IS DISTINCT FROM e->>'operation_id'
   OR i->>'parentId' IS DISTINCT FROM e->>'parent_id' OR i->>'name' IS DISTINCT FROM e->>'name'
   OR i->>'sizeBytes' IS DISTINCT FROM e->>'size_bytes' OR i->>'sha256' IS DISTINCT FROM e->>'sha256'
   OR e->'expected' IS DISTINCT FROM (CASE WHEN c->>'kind'='absent' THEN jsonb_build_object('kind','absent')
     ELSE jsonb_build_object('kind','version','node_id',c->>'nodeId','version',c->>'metadataVersion') END) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION sync_small_batch_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND TG_TABLE_NAME<>'sync_small_batch_budget') THEN
  RAISE EXCEPTION 'small batch original is immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=NEW.root_id;
 IF NOT FOUND OR g.writer_contract<>'folder-file-cas-cj04.v1' OR current_user<>g.writer_owner OR session_user<>g.writer_login THEN
  RAISE EXCEPTION 'small batch writer is unqualified' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='sync_small_batch_operations' THEN
  IF jsonb_typeof(NEW.declaration) IS DISTINCT FROM 'object' OR octet_length(NEW.declaration::text)>73728
   OR (SELECT count(*) FROM jsonb_object_keys(NEW.declaration))<>3 OR NOT NEW.declaration ?& ARRAY['item','input','rulesVersion']
   OR NEW.declaration->'item'->>'operation_id' IS DISTINCT FROM NEW.operation_key
   OR NEW.declaration->'input'->'intent'->>'rootId' IS DISTINCT FROM NEW.root_id::text
   OR NEW.declaration->'input'->'intent'->>'deviceId' IS DISTINCT FROM NEW.device_id::text THEN
   RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 ELSIF TG_TABLE_NAME='sync_small_batches' THEN
  IF NOT public.sync_small_batch_plan_valid(NEW.plan) OR NEW.plan->'manifest'->>'root_id' IS DISTINCT FROM NEW.root_id::text
   OR NEW.plan->'manifest'->>'batch_id' IS DISTINCT FROM NEW.batch_key
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.plan->'inputs') x WHERE x->'intent'->>'deviceId' IS DISTINCT FROM NEW.device_id::text) THEN
   RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 ELSIF TG_OP='UPDATE' AND (NEW.root_id<>OLD.root_id OR NEW.operation_count<OLD.operation_count
   OR NEW.batch_count<OLD.batch_count OR NEW.metadata_bytes<OLD.metadata_bytes) THEN
  RAISE EXCEPTION 'small batch counters cannot rewind' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER sync_small_batch_budget_guard BEFORE INSERT OR UPDATE OR DELETE ON sync_small_batch_budget FOR EACH ROW EXECUTE FUNCTION sync_small_batch_guard();
CREATE TRIGGER sync_small_batch_operations_guard BEFORE INSERT OR UPDATE OR DELETE ON sync_small_batch_operations FOR EACH ROW EXECUTE FUNCTION sync_small_batch_guard();
CREATE TRIGGER sync_small_batches_guard BEFORE INSERT OR UPDATE OR DELETE ON sync_small_batches FOR EACH ROW EXECUTE FUNCTION sync_small_batch_guard();

CREATE FUNCTION sync_small_batch_no_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'small batch originals cannot be truncated' USING ERRCODE='55000'; END $$;
CREATE TRIGGER sync_small_batch_budget_no_truncate BEFORE TRUNCATE ON sync_small_batch_budget FOR EACH STATEMENT EXECUTE FUNCTION sync_small_batch_no_truncate();
CREATE TRIGGER sync_small_batch_operations_no_truncate BEFORE TRUNCATE ON sync_small_batch_operations FOR EACH STATEMENT EXECUTE FUNCTION sync_small_batch_no_truncate();
CREATE TRIGGER sync_small_batches_no_truncate BEFORE TRUNCATE ON sync_small_batches FOR EACH STATEMENT EXECUTE FUNCTION sync_small_batch_no_truncate();

CREATE FUNCTION sync_small_batch_command(command text,binding jsonb,credential jsonb,payload jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE; d public.devices%ROWTYPE;
 r public.resources%ROWTYPE; saved public.sync_small_batches%ROWTYPE; op public.sync_small_batch_operations%ROWTYPE;
 budget public.sync_small_batch_budget%ROWTYPE; j public.operation_journal%ROWTYPE;
 plan jsonb; item jsonb; original jsonb; declaration jsonb; results jsonb:='[]'; requested_batch_key text; n integer:=0;
 new_count bigint:=0; new_bytes bigint:=0; added integer; admitted boolean; replayed boolean;
BEGIN
 IF (SELECT nspname FROM pg_namespace WHERE oid=(SELECT relnamespace FROM pg_class WHERE oid='public.catalog_guard_roots'::regclass)) IS DISTINCT FROM 'public' THEN
  RAISE EXCEPTION 'public namespace required' USING ERRCODE='42501'; END IF;
 IF command IS NULL OR command NOT IN ('register','status') OR NOT public.sync_small_batch_binding(binding)
  OR jsonb_typeof(credential) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(credential))<>3
  OR NOT credential ?& ARRAY['deviceId','deviceKind','tokenHash'] OR octet_length(credential::text)>512
  OR jsonb_typeof(credential->'deviceId') IS DISTINCT FROM 'string' OR credential->>'deviceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(credential->'tokenHash') IS DISTINCT FROM 'string' OR credential->>'tokenHash' !~ '^[a-f0-9]{64}$'
  OR credential->>'deviceKind' NOT IN ('windows_sync','pluto') THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 IF command='register' THEN
  IF NOT public.sync_small_batch_plan_valid(payload) OR ((payload->'manifest')-ARRAY['schema','batch_id','rules_version','items']) IS DISTINCT FROM binding THEN
   RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
  requested_batch_key:=payload->'manifest'->>'batch_id';
 ELSE
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(payload))<>1
   OR jsonb_typeof(payload->'batch_id') IS DISTINCT FROM 'string' OR payload->>'batch_id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
   RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
  requested_batch_key:=payload->>'batch_id';
 END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=(binding->>'root_id')::uuid;
 IF NOT FOUND OR g.writer_contract<>'folder-file-cas-cj04.v1' OR current_user<>g.writer_owner OR session_user<>g.writer_login THEN
  RAISE EXCEPTION 'binding_invalid' USING ERRCODE='42501'; END IF;
 -- No physical work under these locks. Current authority is checked before any
 -- same-key lookup, including a missing batch and an old terminal operation.
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=g.root_id FOR UPDATE;
 SELECT * INTO d FROM public.devices WHERE id=(credential->>'deviceId')::uuid FOR SHARE;
 SELECT * INTO r FROM public.resources WHERE id=g.root_id;
 IF NOT FOUND OR d.id IS NULL OR d.state<>'active' OR NOT d.can_write OR d.token_hash IS DISTINCT FROM credential->>'tokenHash'
  OR d.device_kind IS DISTINCT FROM credential->>'deviceKind' OR d.sync_root_id IS DISTINCT FROM g.root_id OR d.scope_ids IS DISTINCT FROM ARRAY[g.root_id]
  OR (d.expires_at IS NOT NULL AND d.expires_at<=now()) OR r.status<>'active' OR r.type<>'folder'
  OR r.parent_id IS DISTINCT FROM (CASE WHEN d.device_kind='windows_sync' THEN '00000000-0000-7000-8000-000000000004'::uuid ELSE '00000000-0000-7000-8000-000000000009'::uuid END) THEN
  RAISE EXCEPTION 'authorization_changed' USING ERRCODE='42501'; END IF;
 IF c.epoch::text IS DISTINCT FROM binding->>'server_epoch' OR c.binding_version::text IS DISTINCT FROM binding->>'binding_version'
  OR c.descriptor_schema IS DISTINCT FROM binding->>'descriptor_schema' OR c.namespace_state NOT IN ('QUALIFYING','ACTIVE')
  OR (g.active_runtime IS NOT NULL AND (g.active_runtime->>'serverIdentity' IS DISTINCT FROM binding->>'server_identity'
    OR g.active_runtime->>'policyVersion' IS DISTINCT FROM binding->>'policy_version')) THEN
  RAISE EXCEPTION 'binding_invalid' USING ERRCODE='55000'; END IF;
 SELECT * INTO saved FROM public.sync_small_batches WHERE root_id=g.root_id AND device_id=d.id AND batch_key=requested_batch_key;
 replayed:=FOUND;
 IF replayed AND command='register' AND saved.plan IS DISTINCT FROM payload THEN RAISE EXCEPTION 'operation_reused' USING ERRCODE='55000'; END IF;
 IF NOT replayed AND command='status' THEN RETURN jsonb_build_object('found',false); END IF;
 plan:=CASE WHEN replayed THEN saved.plan ELSE payload END;
 IF NOT replayed THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'inputs') x WHERE x->'intent'->>'deviceId' IS DISTINCT FROM d.id::text
    OR x->'intent'->>'deviceKind' IS DISTINCT FROM d.device_kind OR x->>'backendIdentity' IS DISTINCT FROM g.backend_identity) THEN
   RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
  INSERT INTO public.sync_small_batch_budget VALUES(g.root_id,0,0,0) ON CONFLICT DO NOTHING;
  SELECT * INTO budget FROM public.sync_small_batch_budget WHERE root_id=g.root_id FOR UPDATE;
  new_bytes:=octet_length(plan::text);
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(plan->'manifest'->'items') LOOP
  original:=plan->'inputs'->n; n:=n+1;
  declaration:=jsonb_build_object('item',item,'input',original,'rulesVersion',plan->'manifest'->>'rules_version');
  IF NOT replayed THEN
   INSERT INTO public.sync_small_batch_operations(id,operation_key,root_id,device_id,declaration)
    VALUES(gen_random_uuid(),item->>'operation_id',g.root_id,d.id,declaration) ON CONFLICT(operation_key) DO NOTHING;
   GET DIAGNOSTICS added=ROW_COUNT;
   new_count:=new_count+added; IF added=1 THEN new_bytes:=new_bytes+octet_length(declaration::text); END IF;
  END IF;
  SELECT * INTO op FROM public.sync_small_batch_operations WHERE operation_key=item->>'operation_id';
  admitted:=FOUND AND op.root_id=g.root_id AND op.device_id=d.id AND op.declaration=declaration;
  j:=NULL;
  IF admitted THEN
   SELECT * INTO j FROM public.operation_journal WHERE idempotency_key=item->>'operation_id';
   IF FOUND AND (j.upload_execution IS NULL OR j.upload_intent IS DISTINCT FROM original->'intent'
    OR j.sync_root_id IS DISTINCT FROM g.root_id OR j.upload_execution->>'epoch' IS DISTINCT FROM original->>'epoch'
    OR j.upload_execution->>'bindingVersion' IS DISTINCT FROM original->>'bindingVersion'
    OR j.upload_execution->>'backendIdentity' IS DISTINCT FROM original->>'backendIdentity') THEN admitted:=false; END IF;
  END IF;
  results:=results||jsonb_build_array(jsonb_build_object('operationId',item->>'operation_id','admitted',admitted,'uploadId',CASE WHEN admitted THEN j.id ELSE NULL END));
 END LOOP;
 IF NOT replayed THEN
  IF budget.operation_count+new_count>1000000 OR budget.batch_count+1>1000000 OR budget.metadata_bytes+new_bytes>2147483647 THEN
   RAISE EXCEPTION 'admission_full' USING ERRCODE='55000'; END IF;
  UPDATE public.sync_small_batch_budget SET operation_count=operation_count+new_count,batch_count=batch_count+1,metadata_bytes=metadata_bytes+new_bytes WHERE root_id=g.root_id;
  INSERT INTO public.sync_small_batches(id,root_id,device_id,batch_key,plan) VALUES(gen_random_uuid(),g.root_id,d.id,requested_batch_key,plan);
 END IF;
 RETURN jsonb_build_object('found',true,'plan',plan,'items',results,'replayed',replayed);
END $$;
REVOKE ALL ON FUNCTION sync_small_batch_command(text,jsonb,jsonb,jsonb) FROM PUBLIC;
$ddl$,'public.',quote_ident(current_schema())||'.'); END $install$;
