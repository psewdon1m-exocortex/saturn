-- Reuse the locked file and ancestor projections during grouped publication.
-- Preserve original receipts, event order, locks and caller privileges.
SET LOCAL lock_timeout = '2s';
SELECT pg_catalog.pg_advisory_xact_lock(1397967206);
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $migration$
DECLARE
  target regprocedure := 'public.catalog_upload_publish_set_v1(jsonb,jsonb)'::regprocedure;
  previous_search_path text := pg_catalog.current_setting('search_path');
  original text;
  revised text;
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  original := pg_get_functiondef(target);
  IF EXISTS (SELECT 1 FROM public.sync_backend_executor WHERE state <> 'STOPPED') THEN
    RAISE EXCEPTION 'backend must be stopped before publication projection migration';
  END IF;
  IF encode(sha256(convert_to(replace(original,E'\r\n',E'\n'),'UTF8')),'hex') <> 'be2a942bc2b6139cd6195299b1cdf6a54ecb1dfe10bc57c0e13ce5ea7068f9bd' THEN
    RAISE EXCEPTION 'unexpected grouped publication definition before migration 127';
  END IF;
  INSERT INTO public.sync_extension_function_backup (revision, identity, definition)
    VALUES (127, 'public.catalog_upload_publish_set_v1(jsonb,jsonb)', original);
  revised := replace(replace(original,E'\r\n',E'\n'),replace($prior$ WITH source AS(SELECT * FROM jsonb_to_recordset(entries) x(id uuid,node uuid,"firstSeq" bigint)),
 events AS(
   SELECT x.id,x."firstSeq" seq,r.id node_id,public.catalog_namespace_description(r,root) description,'upload.publish'::text reason FROM source x JOIN public.resources r ON r.id=x.node
   UNION ALL SELECT x.id,x."firstSeq"+a.ord,r.id,public.catalog_namespace_description(r,root),'upload.ancestor' FROM source x
     CROSS JOIN (SELECT id,row_number() OVER(ORDER BY id) ord FROM unnest(inroot) id) a JOIN public.resources r ON r.id=a.id)
 INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document)
 SELECT root,c.epoch,e.seq,e.node_id,e.id,jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',e.node_id,'kind','upsert','description',e.description,'reason',e.reason,'actor',actor) FROM events e ORDER BY e.seq;
 SELECT jsonb_agg(jsonb_build_object('id',x.id,'node',x.node,'version',x.version,'firstSeq',x."firstSeq",'lastSeq',x."lastSeq",'receipt',
   jsonb_build_object('schema','saturn.upload-publication.v1','uploadId',x.id,'operationId',x.id,'intentHash',x.hash,'rootId',root,'resourceId',x.node,'versionId',x.version,
     'parentId',parent,'name',x.name,'sizeBytes',x.size::text,'sha256',x.sha,'etag','"sha256-'||x.sha||'"','publishedAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
   'description',public.catalog_namespace_description(r,root),'hash',x.hash) ORDER BY x."firstSeq") INTO results
 FROM jsonb_to_recordset(entries) x(id uuid,node uuid,version uuid,hash text,name text,size bigint,sha text,"firstSeq" bigint,"lastSeq" bigint)
 JOIN public.resources r ON r.id=x.node JOIN public.file_versions v ON v.id=x.version;
 UPDATE public.upload_sessions u SET status='active',resource_id=x.node,updated_at=now() FROM jsonb_to_recordset(results) x(id uuid,node uuid) WHERE u.id=x.id;
 UPDATE public.operation_journal j SET state='active',resource_id=x.node,upload_effect_state='published',upload_receipt=x.receipt,upload_published_version_id=x.version,
   sync_first_seq=x."firstSeq",sync_last_seq=x."lastSeq",sync_result=jsonb_build_object('schema','saturn.catalog-upload-result.v2','status','PUBLISHED','uploadId',x.id,'operationId',x.id,
     'rootId',root,'intentHash',x.hash,'publicationReceipt',x.receipt,'publishedDescription',x.description,'firstSeq',x."firstSeq"::text,'lastSeq',x."lastSeq"::text),updated_at=now()
 FROM jsonb_to_recordset(results) x(id uuid,node uuid,version uuid,receipt jsonb,description jsonb,hash text,"firstSeq" bigint,"lastSeq" bigint) WHERE j.id=x.id;
 UPDATE public.sync_root_clock SET published_seq=c.published_seq+event_count,updated_at=now() WHERE root_id=root;
 SELECT jsonb_agg(jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object(
   'uploadId',j.id,'operationId',j.id,'rootId',root,'intentHash',j.upload_intent_hash,'expectedSizeBytes',u.expected_size::text,
   'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'result',j.sync_result,'replayed',false) ORDER BY a.ord)
 INTO results FROM jsonb_array_elements(items) WITH ORDINALITY a(value,ord) JOIN public.operation_journal j ON j.id=(a.value->>'originalUploadId')::uuid JOIN public.upload_sessions u ON u.id=j.id;$prior$,E'\r\n',E'\n'),replace($next$ SELECT jsonb_agg(jsonb_build_object('id',x.id,'node',x.node,'version',x.version,'firstSeq',x."firstSeq",'lastSeq',x."lastSeq",'receipt',
   jsonb_build_object('schema','saturn.upload-publication.v1','uploadId',x.id,'operationId',x.id,'intentHash',x.hash,'rootId',root,'resourceId',x.node,'versionId',x.version,
     'parentId',parent,'name',x.name,'sizeBytes',x.size::text,'sha256',x.sha,'etag','"sha256-'||x.sha||'"','publishedAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
   'description',public.catalog_namespace_description(r,root),'hash',x.hash) ORDER BY x."firstSeq") INTO results
 FROM jsonb_to_recordset(entries) x(id uuid,node uuid,version uuid,hash text,name text,size bigint,sha text,"firstSeq" bigint,"lastSeq" bigint)
 JOIN public.resources r ON r.id=x.node JOIN public.file_versions v ON v.id=x.version;
 -- A file's description is the same in its event and receipt. Each locked
 -- ancestor's final description is also shared across the originals.
 IF jsonb_array_length(results) IS DISTINCT FROM cardinality(member_ids) THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
 WITH source AS(SELECT * FROM jsonb_to_recordset(results) x(id uuid,node uuid,description jsonb,"firstSeq" bigint)),
 ancestors AS MATERIALIZED (
   SELECT r.id,a.ord,public.catalog_namespace_description(r,root) description
   FROM (SELECT id,row_number() OVER(ORDER BY id) ord FROM unnest(inroot) id) a
   JOIN public.resources r ON r.id=a.id
 ), events AS(
   SELECT x.id,x."firstSeq" seq,x.node node_id,x.description,'upload.publish'::text reason FROM source x
   UNION ALL SELECT x.id,x."firstSeq"+a.ord,a.id,a.description,'upload.ancestor' FROM source x CROSS JOIN ancestors a)
 INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document)
 SELECT root,c.epoch,e.seq,e.node_id,e.id,jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',e.node_id,'kind','upsert','description',e.description,'reason',e.reason,'actor',actor) FROM events e ORDER BY e.seq;
 UPDATE public.upload_sessions u SET status='active',resource_id=x.node,updated_at=now() FROM jsonb_to_recordset(results) x(id uuid,node uuid) WHERE u.id=x.id;
 WITH published AS (
 UPDATE public.operation_journal j SET state='active',resource_id=x.node,upload_effect_state='published',upload_receipt=x.receipt,upload_published_version_id=x.version,
   sync_first_seq=x."firstSeq",sync_last_seq=x."lastSeq",sync_result=jsonb_build_object('schema','saturn.catalog-upload-result.v2','status','PUBLISHED','uploadId',x.id,'operationId',x.id,
     'rootId',root,'intentHash',x.hash,'publicationReceipt',x.receipt,'publishedDescription',x.description,'firstSeq',x."firstSeq"::text,'lastSeq',x."lastSeq"::text),updated_at=now()
 FROM jsonb_to_recordset(results) x(id uuid,node uuid,version uuid,receipt jsonb,description jsonb,hash text,"firstSeq" bigint,"lastSeq" bigint) WHERE j.id=x.id
 RETURNING j.id,j.upload_execution,j.upload_claim_token,j.upload_intent_hash,j.upload_effect_state,j.upload_transfer,j.sync_result)
 SELECT jsonb_agg(jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object(
   'uploadId',j.id,'operationId',j.id,'rootId',root,'intentHash',j.upload_intent_hash,'expectedSizeBytes',u.expected_size::text,
   'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'result',j.sync_result,'replayed',false) ORDER BY a.ord)
 INTO results FROM unnest(member_ids) WITH ORDINALITY a(id,ord) JOIN published j ON j.id=a.id JOIN public.upload_sessions u ON u.id=j.id;
 UPDATE public.sync_root_clock SET published_seq=c.published_seq+event_count,updated_at=now() WHERE root_id=root;$next$,E'\r\n',E'\n'));
  IF encode(sha256(convert_to(revised,'UTF8')),'hex') <> 'aebee731ddb3d8a4527e0d5e2b4aee50a546d9e4f11117b7878f868f401e2b44' THEN
    RAISE EXCEPTION 'unexpected grouped publication replacement for migration 127';
  END IF;
  EXECUTE revised;
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END
$migration$;
