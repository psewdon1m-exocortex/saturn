-- Inactive durable page staging. No namespace enrollment or public capability.
CREATE INDEX resources_active_parent_id_cursor ON resources(parent_id,id) WHERE status='active';
CREATE TABLE sync_snapshot_stage (
  id uuid PRIMARY KEY,
  root_id uuid NOT NULL REFERENCES sync_root_clock(root_id),
  epoch uuid NOT NULL,
  binding_version uuid NOT NULL,
  guard_revision uuid NOT NULL,
  server_identity text NOT NULL CHECK (octet_length(server_identity) BETWEEN 1 AND 128),
  policy_version text NOT NULL CHECK (octet_length(policy_version) BETWEEN 1 AND 128),
  authority_fingerprint text NOT NULL CHECK (authority_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('BASE','OVERLAY','READY','DISCARDED')),
  start_seq bigint NOT NULL CHECK (start_seq >= 0),
  applied_seq bigint NOT NULL CHECK (applied_seq >= start_seq),
  cut_seq bigint CHECK (cut_seq >= start_seq),
  entry_count bigint NOT NULL DEFAULT 0 CHECK (entry_count BETWEEN 0 AND 1000000),
  document_bytes bigint NOT NULL DEFAULT 0 CHECK (document_bytes BETWEEN 0 AND 4294967296),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz NOT NULL,
  absolute_until timestamptz NOT NULL,
  CHECK (lease_until <= absolute_until AND absolute_until <= created_at + interval '24 hours'),
  CHECK ((state = 'READY' AND cut_seq = applied_seq) OR (state <> 'READY' AND cut_seq IS NULL))
);
CREATE INDEX sync_snapshot_stage_root_pin ON sync_snapshot_stage(root_id, epoch, start_seq)
  WHERE state IN ('BASE','OVERLAY');
CREATE TABLE sync_snapshot_entries (
  snapshot_id uuid NOT NULL REFERENCES sync_snapshot_stage(id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 4096),
  PRIMARY KEY (snapshot_id, node_id)
);
CREATE TABLE sync_snapshot_frontier (
  snapshot_id uuid NOT NULL REFERENCES sync_snapshot_stage(id) ON DELETE CASCADE,
  parent_id uuid NOT NULL,
  depth smallint NOT NULL CHECK (depth BETWEEN 0 AND 128),
  last_child_id uuid,
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (snapshot_id, parent_id)
);
CREATE INDEX sync_snapshot_frontier_pending ON sync_snapshot_frontier(snapshot_id, depth, parent_id)
  WHERE NOT complete;
-- Retention cannot remove a build's required (C,D] prefix. Expired/discarded
-- stages carry no continuity claim and may be collected by a bounded janitor.
-- Statically bind the trusted installation namespace. Public guarded use keeps
-- exactly the public body; legacy isolated-schema migrations remain functional.
DO $snapshot_stage_install$ BEGIN
EXECUTE replace($snapshot_stage_ddl$
CREATE FUNCTION guard_sync_snapshot_retention() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.retained_after_seq > OLD.retained_after_seq AND EXISTS (
    SELECT 1 FROM public.sync_snapshot_stage s
    WHERE s.root_id = OLD.root_id AND s.epoch = OLD.epoch
      AND s.state IN ('BASE','OVERLAY') AND s.start_seq < NEW.retained_after_seq
      AND s.lease_until > clock_timestamp() AND s.absolute_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Retained prefix is pinned by an unfinished snapshot' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_snapshot_retention_guard BEFORE UPDATE ON sync_root_clock
  FOR EACH ROW EXECUTE FUNCTION guard_sync_snapshot_retention();
$snapshot_stage_ddl$,'public.',quote_ident(current_schema())||'.');
END $snapshot_stage_install$;
