LOCK TABLE operation_journal IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM operation_journal WHERE upload_intent IS NOT NULL) THEN
  RAISE EXCEPTION 'Upload receipt downgrade requires explicit retirement; sealed identities preserved' USING ERRCODE='55000';
 END IF;
END $$;
DROP TRIGGER sealed_upload_session_truncate_guard ON upload_sessions;
DROP TRIGGER operation_upload_publication_truncate_guard ON operation_journal;
DROP FUNCTION guard_upload_publication_truncate();
DROP TRIGGER sealed_upload_session_guard ON upload_sessions;
DROP FUNCTION guard_sealed_upload_session();
DROP TRIGGER operation_upload_publication_guard ON operation_journal;
DROP FUNCTION guard_upload_publication();
ALTER TABLE operation_journal DROP CONSTRAINT operation_upload_publication_shape,
 DROP COLUMN upload_published_version_id, DROP COLUMN upload_receipt,
 DROP COLUMN upload_intent_hash, DROP COLUMN upload_intent;
