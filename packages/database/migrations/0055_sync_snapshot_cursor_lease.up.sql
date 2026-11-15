-- Inactive internal cursor/session storage. No public capability is advertised.
ALTER TABLE sync_snapshot_stage
  ADD COLUMN entries_cursor text CHECK (entries_cursor IS NULL OR octet_length(entries_cursor)<=4096),
  ADD COLUMN changes_cursor text CHECK (changes_cursor IS NULL OR octet_length(changes_cursor)<=4096),
  ADD COLUMN cursor_count integer NOT NULL DEFAULT 0 CHECK (cursor_count BETWEEN 0 AND 4096),
  ADD CHECK ((entries_cursor IS NULL)=(changes_cursor IS NULL));
CREATE TABLE sync_snapshot_cursor (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  snapshot_id uuid NOT NULL REFERENCES sync_snapshot_stage(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('snapshot','feed')),
  position jsonb NOT NULL CHECK (jsonb_typeof(position)='object' AND octet_length(position::text)<=256),
  next_token text CHECK (next_token IS NULL OR octet_length(next_token)<=4096),
  covered_last_node uuid,
  covered_through_seq bigint CHECK (covered_through_seq>=0),
  covered_count integer CHECK (covered_count BETWEEN 0 AND 500),
  covered_has_more boolean,
  CHECK ((next_token IS NULL AND covered_count IS NULL AND covered_has_more IS NULL)
    OR (next_token IS NOT NULL AND covered_count IS NOT NULL AND covered_has_more IS NOT NULL)),
  CHECK ((kind='snapshot' AND covered_through_seq IS NULL)
    OR (kind='feed' AND covered_last_node IS NULL))
);
CREATE INDEX sync_snapshot_cursor_stage ON sync_snapshot_cursor(snapshot_id,token_hash);

DO $snapshot_cursor_install$ BEGIN
EXECUTE replace($snapshot_cursor_ddl$
CREATE FUNCTION guard_ready_snapshot_header() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF OLD.state='READY' AND (
    NEW.state NOT IN ('READY','DISCARDED')
    OR (NEW.id,NEW.root_id,NEW.epoch,NEW.binding_version,NEW.guard_revision,NEW.server_identity,NEW.policy_version,NEW.authority_fingerprint,NEW.start_seq,NEW.applied_seq,NEW.entry_count,NEW.document_bytes,NEW.created_at,NEW.absolute_until)
      IS DISTINCT FROM (OLD.id,OLD.root_id,OLD.epoch,OLD.binding_version,OLD.guard_revision,OLD.server_identity,OLD.policy_version,OLD.authority_fingerprint,OLD.start_seq,OLD.applied_seq,OLD.entry_count,OLD.document_bytes,OLD.created_at,OLD.absolute_until)
    OR (NEW.state='READY' AND NEW.cut_seq IS DISTINCT FROM OLD.cut_seq)
    OR (NEW.state='DISCARDED' AND NEW.cut_seq IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'READY snapshot cut and original lifetime are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_snapshot_header_immutable BEFORE UPDATE ON sync_snapshot_stage FOR EACH ROW EXECUTE FUNCTION guard_ready_snapshot_header();

-- Final materialized membership/documents remain immutable until the session
-- is explicitly discarded by the bounded janitor. Internal application bugs
-- must not change a covered response after it has already been acknowledged.
CREATE FUNCTION guard_ready_snapshot_entries() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE phase text;
BEGIN
  SELECT state INTO phase FROM public.sync_snapshot_stage WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.snapshot_id ELSE NEW.snapshot_id END FOR SHARE;
  IF phase='READY' OR (TG_OP='UPDATE' AND OLD.snapshot_id IS DISTINCT FROM NEW.snapshot_id) THEN
    RAISE EXCEPTION 'READY snapshot documents are immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER sync_snapshot_entries_immutable BEFORE INSERT OR UPDATE OR DELETE ON sync_snapshot_entries FOR EACH ROW EXECUTE FUNCTION guard_ready_snapshot_entries();
CREATE FUNCTION guard_snapshot_entries_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Snapshot entry truncation is not a bounded operation' USING ERRCODE='55000';
END $$;
CREATE TRIGGER sync_snapshot_entries_no_truncate BEFORE TRUNCATE ON sync_snapshot_entries FOR EACH STATEMENT EXECUTE FUNCTION guard_snapshot_entries_truncate();

-- READY readers start at D. Retain D while the original immutable session
-- lease is live, including replay of already-covered feed responses.
CREATE OR REPLACE FUNCTION guard_sync_snapshot_retention() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.retained_after_seq > OLD.retained_after_seq AND EXISTS (
    SELECT 1 FROM public.sync_snapshot_stage s WHERE s.root_id=OLD.root_id AND s.epoch=OLD.epoch
      AND s.state IN ('BASE','OVERLAY','READY')
      AND (CASE WHEN s.state='READY' THEN s.cut_seq ELSE s.start_seq END)<NEW.retained_after_seq
      AND s.lease_until>clock_timestamp() AND s.absolute_until>clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Retained prefix is pinned by a live snapshot session' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
$snapshot_cursor_ddl$,'public.',quote_ident(current_schema())||'.');
END $snapshot_cursor_install$;
