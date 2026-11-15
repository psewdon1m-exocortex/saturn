-- Inactive A1 foundation. No live root is enrolled and no existing key is backfilled.
ALTER TABLE operation_journal ADD COLUMN catalog_intent jsonb;
ALTER TABLE operation_journal ADD COLUMN catalog_effect_state text;

CREATE FUNCTION catalog_folder_shape(j operation_journal) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN j.catalog_intent IS NULL THEN j.catalog_effect_state IS NULL
 ELSE coalesce(
   jsonb_typeof(j.catalog_intent)='object' AND octet_length(j.catalog_intent::text)<=8192
   AND (SELECT count(*) FROM jsonb_object_keys(j.catalog_intent))=13
   AND j.catalog_intent ?& ARRAY['schema','kind','operationId','idempotencyKey','rootId','epoch','bindingVersion','parentId','name','mode','nodeId','backendIdentity','actor']
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(j.catalog_intent) item WHERE item.key<>'actor' AND jsonb_typeof(item.value)<>'string')
   AND j.catalog_intent->>'schema'='saturn.catalog-folder-intent.v1' AND j.catalog_intent->>'kind'='folder.create'
   AND j.operation_type='folder_create' AND j.upload_id IS NULL AND j.upload_intent IS NULL
   AND j.catalog_intent->>'operationId'=j.id::text AND j.idempotency_key='catalog-folder:'||(j.catalog_intent->>'idempotencyKey')
   AND (j.catalog_intent->>'idempotencyKey') ~ '^[A-Za-z0-9._:-]{8,128}$'
   AND j.catalog_intent->>'rootId'=j.sync_root_id::text AND j.catalog_intent->>'epoch'=j.sync_epoch::text
   AND (j.catalog_intent->>'bindingVersion') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND (j.catalog_intent->>'parentId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND (j.catalog_intent->>'nodeId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND (j.catalog_intent->>'backendIdentity') ~ '^[A-Za-z0-9._:-]{1,128}$'
   AND (j.catalog_intent->>'mode') IN ('create','ensure')
   AND octet_length(j.catalog_intent->>'name') BETWEEN 1 AND 1020
   AND (j.catalog_intent->>'name') NOT IN ('.','..') AND (j.catalog_intent->>'name') !~ '[/\\]'
   AND jsonb_typeof(j.catalog_intent->'actor')='object' AND (SELECT count(*) FROM jsonb_object_keys(j.catalog_intent->'actor'))=2
   AND j.catalog_intent->'actor' ?& ARRAY['type','id']
   AND ((j.catalog_intent->'actor'->>'type'='device_token' AND (j.catalog_intent->'actor'->>'id') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
     OR (j.catalog_intent->'actor'->>'type' IN ('owner_web','owner_bootstrap') AND j.catalog_intent->'actor'->>'id'='owner'))
   AND j.catalog_effect_state IN ('prepared','physical_pending','reconciliation_required','published','not_required')
   AND CASE WHEN j.sync_result IS NULL THEN j.catalog_effect_state IN ('prepared','physical_pending','reconciliation_required') AND j.state<>'active' AND j.resource_id IS NULL
   ELSE
     j.state='active' AND jsonb_typeof(j.sync_result)='object' AND octet_length(j.sync_result::text)<=8192
     AND (SELECT count(*) FROM jsonb_object_keys(j.sync_result))=6
     AND j.sync_result ?& ARRAY['schema','operationId','intentHash','rootId','status','description']
     AND NOT EXISTS(SELECT 1 FROM jsonb_each(j.sync_result) item WHERE item.key<>'description' AND jsonb_typeof(item.value)<>'string')
     AND j.sync_result->>'schema'='saturn.catalog-folder-result.v1' AND j.sync_result->>'operationId'=j.id::text
     AND j.sync_result->>'rootId'=j.sync_root_id::text AND j.sync_result->>'intentHash'=j.sync_intent_hash
     AND jsonb_typeof(j.sync_result->'description')='object' AND (SELECT count(*) FROM jsonb_object_keys(j.sync_result->'description'))=9
     AND j.sync_result->'description' ?& ARRAY['node_id','parent_id','name','type','size_bytes','content_sha256','content_version_id','version','availability']
     AND NOT EXISTS(SELECT 1 FROM jsonb_each(j.sync_result->'description') item WHERE item.key NOT IN ('content_sha256','content_version_id') AND jsonb_typeof(item.value)<>'string')
     AND j.sync_result->'description'->>'type'='folder' AND j.sync_result->'description'->>'node_id'=j.resource_id::text
     AND j.sync_result->'description'->>'parent_id'=j.catalog_intent->>'parentId'
     AND lower(j.sync_result->'description'->>'name')=lower(j.catalog_intent->>'name')
     AND octet_length(j.sync_result->'description'->>'name') BETWEEN 1 AND 1020
     AND jsonb_typeof(j.sync_result->'description'->'size_bytes')='string'
     AND (j.sync_result->'description'->>'size_bytes') ~ '^(0|[1-9][0-9]{0,18})$'
     AND CASE WHEN (j.sync_result->'description'->>'size_bytes') ~ '^(0|[1-9][0-9]{0,18})$' THEN (j.sync_result->'description'->>'size_bytes')::numeric<=9223372036854775807 ELSE false END
     AND j.sync_result->'description'->'content_sha256'='null'::jsonb AND j.sync_result->'description'->'content_version_id'='null'::jsonb
     AND (j.sync_result->'description'->>'version') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
     AND (j.sync_result->'description'->>'availability') IN ('AVAILABLE','UNAVAILABLE','UNKNOWN')
     AND ((j.sync_result->>'status'='CREATED' AND j.catalog_effect_state='published'
       AND j.sync_result->'description'->>'node_id'=j.catalog_intent->>'nodeId'
       AND j.sync_result->'description'->>'size_bytes'='0' AND j.sync_result->'description'->>'availability'='AVAILABLE'
       AND j.sync_first_seq IS NOT NULL AND j.sync_last_seq IS NOT NULL AND j.sync_first_seq>0 AND j.sync_last_seq>=j.sync_first_seq)
     OR (j.sync_result->>'status'='EXISTING' AND j.catalog_effect_state='not_required' AND j.catalog_intent->>'mode'='ensure'
       AND j.sync_first_seq IS NULL AND j.sync_last_seq IS NULL))
   END,false) END
$$;
ALTER TABLE operation_journal ADD CONSTRAINT operation_catalog_folder_shape CHECK(catalog_folder_shape(operation_journal));

ALTER TABLE operation_journal DROP CONSTRAINT operation_sync_receipt_shape;
ALTER TABLE operation_journal ADD CONSTRAINT operation_sync_receipt_shape CHECK (
 (sync_root_id IS NULL AND sync_epoch IS NULL AND sync_first_seq IS NULL AND sync_last_seq IS NULL AND sync_intent_hash IS NULL AND sync_result IS NULL)
 OR (sync_root_id IS NOT NULL AND sync_epoch IS NOT NULL AND sync_intent_hash IS NOT NULL AND sync_intent_hash ~ '^[a-f0-9]{64}$'
   AND ((sync_first_seq IS NULL AND sync_last_seq IS NULL AND sync_result IS NULL)
     OR (sync_first_seq IS NOT NULL AND sync_last_seq IS NOT NULL AND sync_first_seq>0 AND sync_last_seq>=sync_first_seq AND sync_result IS NOT NULL AND state='active')
     OR (catalog_intent IS NOT NULL AND catalog_effect_state='not_required' AND sync_first_seq IS NULL AND sync_last_seq IS NULL
       AND state='active' AND sync_result->>'schema'='saturn.catalog-folder-result.v1' AND sync_result->>'status'='EXISTING' AND catalog_folder_shape(operation_journal))))
);

CREATE FUNCTION guard_catalog_folder_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.catalog_intent IS NULL AND NEW.catalog_intent IS NOT NULL THEN
   RAISE EXCEPTION 'Existing operation cannot be backfilled as a catalog folder intent' USING ERRCODE='55000';
 END IF;
 IF OLD.catalog_intent IS NOT NULL THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Sealed catalog folder key cannot be deleted' USING ERRCODE='55000'; END IF;
   IF ROW(NEW.id,NEW.operation_type,NEW.idempotency_key,NEW.upload_id,NEW.catalog_intent,NEW.payload) IS DISTINCT FROM
      ROW(OLD.id,OLD.operation_type,OLD.idempotency_key,OLD.upload_id,OLD.catalog_intent,OLD.payload)
     OR (OLD.sync_result IS NOT NULL AND ROW(NEW.resource_id,NEW.catalog_effect_state) IS DISTINCT FROM ROW(OLD.resource_id,OLD.catalog_effect_state))
     OR (NEW.catalog_effect_state IS DISTINCT FROM OLD.catalog_effect_state AND NOT (
       (OLD.catalog_effect_state='prepared' AND NEW.catalog_effect_state IN ('physical_pending','not_required'))
       OR (OLD.catalog_effect_state='physical_pending' AND NEW.catalog_effect_state IN ('reconciliation_required','published')))) THEN
     RAISE EXCEPTION 'Sealed catalog folder intent/result/lifecycle is immutable' USING ERRCODE='55000';
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER operation_catalog_folder_guard BEFORE UPDATE OR DELETE ON operation_journal
 FOR EACH ROW EXECUTE FUNCTION guard_catalog_folder_intent();
CREATE FUNCTION guard_catalog_folder_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM operation_journal WHERE catalog_intent IS NOT NULL) THEN
   RAISE EXCEPTION 'Sealed catalog folder keys require explicit retirement before reset' USING ERRCODE='55000';
 END IF; RETURN NULL;
END $$;
CREATE TRIGGER operation_catalog_folder_truncate_guard BEFORE TRUNCATE ON operation_journal
 FOR EACH STATEMENT EXECUTE FUNCTION guard_catalog_folder_truncate();
CREATE INDEX operation_catalog_folder_pending_idx ON operation_journal(sync_root_id,(catalog_intent->>'parentId'),lower(catalog_intent->>'name'))
 WHERE catalog_intent IS NOT NULL AND sync_result IS NULL;
