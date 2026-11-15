-- Replace object-key counts in the two immutable upload validators.
-- Preserve signatures, authority and every other validation rule.
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.pg_advisory_xact_lock(1397967206);
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $migration$
DECLARE
  rule record;
  target regprocedure;
  original text;
  previous_search_path text := pg_catalog.current_setting('search_path');
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  IF EXISTS (SELECT 1 FROM public.sync_backend_executor WHERE state <> 'STOPPED') THEN
    RAISE EXCEPTION 'backend must be stopped before upload keyset migration';
  END IF;
  FOR rule IN SELECT * FROM (VALUES
    ('public.catalog_upload_intent_valid(jsonb)', 'e216f0c57eb0663d1b321d878be903c1731abf83d2f87142d4dfe89ec243fdd2', '9ef0131caa8ae1ad4bd80b3901ccce8a9b7c282afdd45d9247a7c1fea24c9579', $keyset$CREATE OR REPLACE FUNCTION public.catalog_upload_intent_valid(i jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE modern boolean; k text; entry jsonb; prior_parent text; seen text[]:='{}'; n integer:=0;
BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR octet_length(i::text)>65536 THEN RETURN false; END IF;
 modern:=i->>'schema'='saturn.upload-intent.v2';
 IF jsonb_typeof(i->'schema') IS DISTINCT FROM 'string' OR i->>'schema' NOT IN ('saturn.upload-intent.v1','saturn.upload-intent.v2')
   OR (i - (ARRAY['schema','deviceKind','deviceId','rootId','requestPath','idempotencyKey','parentId','name','targetId','sizeBytes','sha256','ifMatch','ifNoneMatch','requireAbsent','expectedVersionId'] || CASE WHEN modern THEN ARRAY['condition','parentTopology'] ELSE '{}'::text[] END))<>'{}'::jsonb
   OR NOT i ?& ARRAY['schema','deviceKind','deviceId','rootId','requestPath','idempotencyKey','parentId','name','targetId','sizeBytes','sha256','ifMatch','ifNoneMatch','requireAbsent','expectedVersionId']
   OR (modern AND NOT i ?& ARRAY['condition','parentTopology']) OR (NOT modern AND i->>'deviceKind' IS DISTINCT FROM 'windows_sync')
   OR i->>'deviceKind' NOT IN ('windows_sync','pluto') OR jsonb_typeof(i->'requireAbsent') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['deviceId','rootId','parentId'] LOOP
   IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR i->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['targetId','expectedVersionId'] LOOP
   IF i->k IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR i->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN RETURN false; END IF;
 END LOOP;
 IF jsonb_typeof(i->'requestPath') IS DISTINCT FROM 'string' OR length(i->>'requestPath') NOT BETWEEN 1 AND 4096
   OR jsonb_typeof(i->'idempotencyKey') IS DISTINCT FROM 'string' OR i->>'idempotencyKey' !~ '^[A-Za-z0-9._:-]{8,200}$'
   OR jsonb_typeof(i->'name') IS DISTINCT FROM 'string' OR length(i->>'name') NOT BETWEEN 1 AND 255 OR i->>'name' IN ('.','..') OR i->>'name' ~ '[/\\[:cntrl:]]'
   OR jsonb_typeof(i->'sizeBytes') IS DISTINCT FROM 'string' OR i->>'sizeBytes' !~ '^(0|[1-9][0-9]{0,18})$'
   OR jsonb_typeof(i->'sha256') IS DISTINCT FROM 'string' OR i->>'sha256' !~ '^[a-f0-9]{64}$'
   OR (i->'ifMatch' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(i->'ifMatch') IS DISTINCT FROM 'string' OR length(i->>'ifMatch')>100))
   OR i->'ifNoneMatch' NOT IN ('null'::jsonb,'"*"'::jsonb) THEN RETURN false; END IF;
 IF (i->>'sizeBytes')::numeric>9223372036854775807 OR (NOT modern AND i->>'idempotencyKey' !~ '^sync-resume-[a-f0-9]{64}$') THEN RETURN false; END IF;
 IF (i->>'requireAbsent')::boolean THEN
   IF i->'targetId'<>'null'::jsonb OR i->'expectedVersionId'<>'null'::jsonb OR i->'ifMatch'<>'null'::jsonb OR i->>'ifNoneMatch' IS DISTINCT FROM '*' THEN RETURN false; END IF;
   IF modern AND i->'condition' IS DISTINCT FROM '{"kind":"absent"}'::jsonb THEN RETURN false; END IF;
 ELSE
   -- Legacy SHA ETag is not a modern metadata CAS token.
   IF NOT modern OR i->'targetId'='null'::jsonb OR i->'expectedVersionId'='null'::jsonb OR i->'ifNoneMatch'<>'null'::jsonb
     OR jsonb_typeof(i->'condition') IS DISTINCT FROM 'object' OR ((i->'condition') - ARRAY['kind','nodeId','metadataVersion'])<>'{}'::jsonb
     OR NOT (i->'condition') ?& ARRAY['kind','nodeId','metadataVersion'] OR i->'condition'->>'kind' IS DISTINCT FROM 'match'
     OR i->'condition'->>'nodeId' IS DISTINCT FROM i->>'targetId'
     OR jsonb_typeof(i->'condition'->'metadataVersion') IS DISTINCT FROM 'string'
     OR i->'condition'->>'metadataVersion' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END IF;
 IF modern THEN
   IF jsonb_typeof(i->'parentTopology') IS DISTINCT FROM 'array' OR jsonb_array_length(i->'parentTopology') NOT BETWEEN 1 AND 129 THEN RETURN false; END IF;
   FOR entry IN SELECT value FROM jsonb_array_elements(i->'parentTopology') LOOP
     IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR (entry - ARRAY['nodeId','parentId','name'])<>'{}'::jsonb OR NOT entry ?& ARRAY['nodeId','parentId','name']
       OR jsonb_typeof(entry->'nodeId') IS DISTINCT FROM 'string' OR entry->>'nodeId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
       OR (entry->'parentId' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(entry->'parentId') IS DISTINCT FROM 'string' OR entry->>'parentId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'))
       OR jsonb_typeof(entry->'name') IS DISTINCT FROM 'string' OR length(entry->>'name') NOT BETWEEN 1 AND 255 OR entry->>'name' IN ('.','..') OR entry->>'name' ~ '[/\\[:cntrl:]]'
       OR entry->>'nodeId'=ANY(seen) OR (n=0 AND entry->>'nodeId' IS DISTINCT FROM i->>'parentId') OR (n>0 AND entry->>'nodeId' IS DISTINCT FROM prior_parent) THEN RETURN false; END IF;
     seen:=array_append(seen,entry->>'nodeId');prior_parent:=entry->>'parentId';n:=n+1;
   END LOOP;
   IF seen[n] IS DISTINCT FROM i->>'rootId' OR prior_parent IS NOT NULL THEN RETURN false; END IF;
 ELSE
   IF octet_length(i::text)>8192 THEN RETURN false; END IF;
 END IF;
 RETURN true;
END $function$
$keyset$),
    ('public.catalog_upload_shape(public.operation_journal)', 'f2ff6bfbb8235a79499b177e74d9f25bfdfb5517bbcb2055997abf55ba511336', 'f1da5e752739f05500df4689ece9716133fa08ef7c9d5862ac6471f75442b8dd', $keyset$CREATE OR REPLACE FUNCTION public.catalog_upload_shape(j public.operation_journal)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE k text; entry jsonb; seen text[]:='{}'; n integer:=0; t jsonb;
BEGIN
 IF j.upload_execution IS NULL THEN RETURN j.upload_effect_state IS NULL AND j.upload_transfer IS NULL AND j.upload_last_transfer IS NULL AND j.upload_claim_token IS NULL; END IF;
 IF NOT public.catalog_upload_intent_valid(j.upload_intent) OR j.operation_type<>'upload' OR j.upload_id IS DISTINCT FROM j.id
   OR j.upload_intent_hash IS DISTINCT FROM public.catalog_upload_hash(j.upload_intent) OR j.sync_intent_hash IS DISTINCT FROM j.upload_intent_hash
   OR j.sync_root_id::text IS DISTINCT FROM j.upload_intent->>'rootId' OR j.sync_epoch IS NULL OR j.catalog_intent IS NOT NULL
   OR jsonb_typeof(j.upload_execution) IS DISTINCT FROM 'object' OR octet_length(j.upload_execution::text)>65536
   OR (j.upload_execution - ARRAY['schema','epoch','bindingVersion','guardRevision','backendIdentity','nodeId','versionId','tempPath','targetPath','archivePath','before','pathTopology'])<>'{}'::jsonb
   OR NOT j.upload_execution ?& ARRAY['schema','epoch','bindingVersion','guardRevision','backendIdentity','nodeId','versionId','tempPath','targetPath','archivePath','before','pathTopology']
   OR j.upload_execution->>'schema' IS DISTINCT FROM 'saturn.catalog-upload-execution.v1'
   OR j.upload_execution->>'epoch' IS DISTINCT FROM j.sync_epoch::text
   OR j.upload_effect_state IS NULL OR j.upload_effect_state NOT IN ('transport','verified','physical_pending','reconciliation_required','published','not_published') THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['epoch','bindingVersion','guardRevision','nodeId','versionId'] LOOP
   IF jsonb_typeof(j.upload_execution->k) IS DISTINCT FROM 'string' OR j.upload_execution->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 IF jsonb_typeof(j.upload_execution->'backendIdentity') IS DISTINCT FROM 'string' OR j.upload_execution->>'backendIdentity' !~ '^[A-Za-z0-9._:-]{1,128}$'
   OR j.upload_execution->>'tempPath' IS DISTINCT FROM '_system/incoming/'||j.id::text||'.part' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['tempPath','targetPath','archivePath'] LOOP
   IF k='archivePath' AND j.upload_execution->k='null'::jsonb THEN CONTINUE; END IF;
   IF jsonb_typeof(j.upload_execution->k) IS DISTINCT FROM 'string' OR octet_length(j.upload_execution->>k) NOT BETWEEN 1 AND 4096 OR j.upload_execution->>k ~ '(^/|/$|//|\\|[[:cntrl:]]|(^|/)\.\.?(/|$))' THEN RETURN false; END IF;
 END LOOP;
 IF jsonb_typeof(j.upload_execution->'pathTopology') IS DISTINCT FROM 'array' OR jsonb_array_length(j.upload_execution->'pathTopology') NOT BETWEEN 1 AND 129 THEN RETURN false; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(j.upload_execution->'pathTopology') LOOP
   IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR (entry - ARRAY['nodeId','storagePath'])<>'{}'::jsonb OR NOT entry ?& ARRAY['nodeId','storagePath']
     OR jsonb_typeof(entry->'nodeId') IS DISTINCT FROM 'string' OR entry->>'nodeId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR entry->>'nodeId'=ANY(seen)
     OR jsonb_typeof(entry->'storagePath') IS DISTINCT FROM 'string' OR octet_length(entry->>'storagePath') NOT BETWEEN 1 AND 4096 OR entry->>'storagePath' ~ '(^/|/$|//|\\|[[:cntrl:]]|(^|/)\.\.?(/|$))'
     OR (n=0 AND entry->>'nodeId' IS DISTINCT FROM j.upload_intent->>'parentId')
     OR (j.upload_intent->>'schema'='saturn.upload-intent.v2' AND entry->>'nodeId' IS DISTINCT FROM j.upload_intent->'parentTopology'->n->>'nodeId') THEN RETURN false; END IF;
   seen:=array_append(seen,entry->>'nodeId');n:=n+1;
 END LOOP;
 IF seen[n] IS DISTINCT FROM j.sync_root_id::text OR (j.upload_intent->>'schema'='saturn.upload-intent.v2' AND n<>jsonb_array_length(j.upload_intent->'parentTopology')) THEN RETURN false; END IF;
 FOREACH t IN ARRAY ARRAY[j.upload_transfer,j.upload_last_transfer] LOOP
   IF t IS NULL THEN CONTINUE; END IF;
   IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR (t - ARRAY['token','offset','length','originalUploadId'])<>'{}'::jsonb OR NOT t ?& ARRAY['token','offset','length','originalUploadId']
     OR jsonb_typeof(t->'token') IS DISTINCT FROM 'string' OR t->>'token' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
     OR jsonb_typeof(t->'offset') IS DISTINCT FROM 'string' OR t->>'offset' !~ '^(0|[1-9][0-9]{0,18})$' OR (t->>'offset')::numeric>9223372036854775807
     OR jsonb_typeof(t->'length') IS DISTINCT FROM 'string' OR t->>'length' !~ '^[1-9][0-9]{0,7}$' OR (t->>'length')::numeric>8388608
     OR t->>'originalUploadId' IS DISTINCT FROM j.id::text THEN RETURN false; END IF;
 END LOOP;
 IF j.upload_transfer IS NOT NULL AND j.upload_effect_state<>'transport' THEN RETURN false; END IF;
 IF (j.upload_effect_state IN ('physical_pending','reconciliation_required','published')) IS DISTINCT FROM (j.upload_claim_token IS NOT NULL) THEN RETURN false; END IF;
 IF j.sync_result IS NULL THEN RETURN j.upload_effect_state IN ('transport','verified','physical_pending','reconciliation_required') AND j.upload_receipt IS NULL; END IF;
 IF j.upload_effect_state='not_published' THEN RETURN j.state='active' AND j.upload_receipt IS NULL AND j.sync_first_seq IS NULL AND j.sync_last_seq IS NULL
   AND j.sync_result=jsonb_build_object('schema','saturn.catalog-upload-result.v2','status','NOT_PUBLISHED','uploadId',j.id,'operationId',j.id,'rootId',j.sync_root_id,'intentHash',j.upload_intent_hash,'reason','cancelled_before_publication'); END IF;
 RETURN j.upload_effect_state='published' AND j.state='active' AND j.upload_receipt IS NOT NULL AND j.sync_first_seq>0 AND j.sync_last_seq>=j.sync_first_seq
   AND j.sync_result->>'schema'='saturn.catalog-upload-result.v2' AND j.sync_result->>'status'='PUBLISHED'
   AND j.sync_result->>'uploadId'=j.id::text AND j.sync_result->>'operationId'=j.id::text
   AND j.sync_result->>'rootId'=j.sync_root_id::text AND j.sync_result->>'intentHash'=j.upload_intent_hash
   AND j.sync_result->'publicationReceipt'=j.upload_receipt AND j.sync_result->>'firstSeq'=j.sync_first_seq::text AND j.sync_result->>'lastSeq'=j.sync_last_seq::text
   AND j.sync_result->'publishedDescription'->>'node_id'=j.resource_id::text AND j.sync_result->'publishedDescription'->>'availability'='AVAILABLE';
END $function$
$keyset$)
  ) AS expected(identity, old_hash, new_hash, definition)
  LOOP
    target := rule.identity::regprocedure;
    original := pg_get_functiondef(target);
    IF encode(sha256(convert_to(replace(original,E'\r\n',E'\n'),'UTF8')),'hex') <> rule.old_hash THEN
      RAISE EXCEPTION 'unexpected upload validator definition before migration 129: %', rule.identity;
    END IF;
    INSERT INTO public.sync_extension_function_backup (revision, identity, definition)
      VALUES (129, rule.identity, original);
    EXECUTE rule.definition;
    IF encode(sha256(convert_to(replace(pg_get_functiondef(target),E'\r\n',E'\n'),'UTF8')),'hex') <> rule.new_hash THEN
      RAISE EXCEPTION 'unexpected revised upload validator definition in migration 129: %', rule.identity;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END
$migration$;
