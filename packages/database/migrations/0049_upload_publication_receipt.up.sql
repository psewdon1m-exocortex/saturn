-- Independently qualified Windows resumable receipts; no root/feed activation.
ALTER TABLE operation_journal
 ADD COLUMN upload_intent jsonb,
 ADD COLUMN upload_intent_hash text,
 ADD COLUMN upload_receipt jsonb,
 ADD COLUMN upload_published_version_id uuid REFERENCES file_versions(id),
 ADD CONSTRAINT operation_upload_publication_shape CHECK (
  (upload_intent IS NULL AND upload_intent_hash IS NULL AND upload_receipt IS NULL AND upload_published_version_id IS NULL)
  OR COALESCE((operation_type='upload' AND upload_id=id AND upload_intent IS NOT NULL
   AND jsonb_typeof(upload_intent)='object' AND octet_length(upload_intent::text)<=8192
   AND upload_intent->>'schema'='saturn.upload-intent.v1'
   AND upload_intent_hash IS NOT NULL AND upload_intent_hash ~ '^[a-f0-9]{64}$'
   AND ((upload_receipt IS NULL AND upload_published_version_id IS NULL)
    OR (state='active' AND resource_id IS NOT NULL AND upload_published_version_id IS NOT NULL
     AND jsonb_typeof(upload_receipt)='object' AND octet_length(upload_receipt::text)<=16384
     AND upload_receipt->>'schema'='saturn.upload-publication.v1'
     AND upload_receipt->>'uploadId'=id::text AND upload_receipt->>'operationId'=id::text
     AND upload_receipt->>'intentHash'=upload_intent_hash
     AND upload_receipt->>'resourceId'=resource_id::text
     AND upload_receipt->>'versionId'=upload_published_version_id::text))),false)
 );
CREATE FUNCTION guard_upload_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.upload_intent IS NULL AND NEW.upload_intent IS NOT NULL THEN
  RAISE EXCEPTION 'Upload identity must be sealed at creation; legacy rows cannot be backfilled' USING ERRCODE='55000';
 END IF;
 IF OLD.upload_intent IS NOT NULL THEN
  IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Sealed upload identity cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.id,NEW.operation_type,NEW.upload_id,NEW.idempotency_key,NEW.upload_intent,NEW.upload_intent_hash)
    IS DISTINCT FROM ROW(OLD.id,OLD.operation_type,OLD.upload_id,OLD.idempotency_key,OLD.upload_intent,OLD.upload_intent_hash)
   OR (OLD.upload_receipt IS NOT NULL AND ROW(NEW.state,NEW.resource_id,NEW.upload_receipt,NEW.upload_published_version_id)
    IS DISTINCT FROM ROW(OLD.state,OLD.resource_id,OLD.upload_receipt,OLD.upload_published_version_id)) THEN
   RAISE EXCEPTION 'Upload publication identity/receipt is immutable' USING ERRCODE='55000';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER operation_upload_publication_guard BEFORE UPDATE OR DELETE ON operation_journal
 FOR EACH ROW EXECUTE FUNCTION guard_upload_publication();

CREATE FUNCTION guard_sealed_upload_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sealed operation_journal%ROWTYPE;
BEGIN
 SELECT * INTO sealed FROM operation_journal WHERE id=OLD.id AND upload_id=OLD.id;
 IF sealed.upload_intent IS NOT NULL THEN
  IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Sealed upload session cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.id,NEW.idempotency_key,NEW.parent_id,NEW.filename,NEW.expected_size,NEW.expected_sha256,
     NEW.overwrite_resource_id,NEW.expected_version_id,NEW.require_absent,NEW.audit_actor_type,NEW.audit_actor_id,NEW.temp_path)
   IS DISTINCT FROM ROW(OLD.id,OLD.idempotency_key,OLD.parent_id,OLD.filename,OLD.expected_size,OLD.expected_sha256,
     OLD.overwrite_resource_id,OLD.expected_version_id,OLD.require_absent,OLD.audit_actor_type,OLD.audit_actor_id,OLD.temp_path)
   OR (sealed.upload_receipt IS NOT NULL AND ROW(NEW.status,NEW.resource_id,NEW.actual_sha256,NEW.received_size)
    IS DISTINCT FROM ROW(OLD.status,OLD.resource_id,OLD.actual_sha256,OLD.received_size)) THEN
   RAISE EXCEPTION 'Sealed upload session identity/publication is immutable' USING ERRCODE='55000';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sealed_upload_session_guard BEFORE UPDATE OR DELETE ON upload_sessions
 FOR EACH ROW EXECUTE FUNCTION guard_sealed_upload_session();

-- Row triggers do not run for TRUNCATE; preserve accepted keys on that path too.
CREATE FUNCTION guard_upload_publication_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM operation_journal WHERE upload_intent IS NOT NULL) THEN
  RAISE EXCEPTION 'Sealed upload identities cannot be truncated' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER operation_upload_publication_truncate_guard BEFORE TRUNCATE ON operation_journal
 FOR EACH STATEMENT EXECUTE FUNCTION guard_upload_publication_truncate();
CREATE TRIGGER sealed_upload_session_truncate_guard BEFORE TRUNCATE ON upload_sessions
 FOR EACH STATEMENT EXECUTE FUNCTION guard_upload_publication_truncate();
