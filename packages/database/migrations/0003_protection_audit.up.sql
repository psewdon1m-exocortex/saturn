ALTER TABLE resources
  ADD COLUMN retention_class text NOT NULL DEFAULT 'general'
  CHECK (retention_class IN (
    'general', 'mastermind_markdown', 'mastermind_attachment',
    'keepass', 'laboratory_immutable'
  ));
ALTER TABLE resources DROP CONSTRAINT resources_status_check;
ALTER TABLE resources ADD CONSTRAINT resources_status_check
  CHECK (status IN ('pending', 'active', 'trashed', 'missing', 'error', 'quarantined', 'purged'));

ALTER TABLE file_versions
  ADD COLUMN state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'expired', 'missing', 'error')),
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN purge_after timestamptz;
CREATE INDEX file_versions_resource_created_idx
  ON file_versions (resource_id, created_at DESC, id DESC);
CREATE INDEX file_versions_purge_idx
  ON file_versions (state, purge_after) WHERE purge_after IS NOT NULL;

ALTER TABLE upload_sessions
  ADD COLUMN overwrite_resource_id uuid REFERENCES resources(id);

CREATE TABLE audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  resource_id uuid REFERENCES resources(id),
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  correlation_id text NOT NULL,
  source_ip_hash text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_action_not_blank CHECK (length(btrim(action)) > 0),
  CONSTRAINT audit_correlation_not_blank CHECK (length(btrim(correlation_id)) > 0)
);
CREATE INDEX audit_events_time_idx ON audit_events (occurred_at DESC, sequence DESC);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_id, occurred_at DESC);
CREATE UNIQUE INDEX audit_events_idempotency_idx
  ON audit_events (correlation_id, action, outcome);

CREATE FUNCTION vault_deny_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION vault_deny_audit_mutation();

CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('metadata', 'full_hash')),
  state text NOT NULL CHECK (state IN ('running', 'complete', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  scanned_resources bigint NOT NULL DEFAULT 0,
  scanned_storage_entries bigint NOT NULL DEFAULT 0,
  issue_count bigint NOT NULL DEFAULT 0,
  error_code text
);
CREATE UNIQUE INDEX reconciliation_single_running_idx
  ON reconciliation_runs ((1)) WHERE state = 'running';

CREATE TABLE reconciliation_issues (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  issue_type text NOT NULL CHECK (issue_type IN (
    'missing', 'orphaned', 'size_mismatch', 'checksum_mismatch',
    'operation_interrupted'
  )),
  resource_id uuid REFERENCES resources(id),
  storage_path text NOT NULL,
  expected jsonb NOT NULL DEFAULT '{}'::jsonb,
  actual jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_issues_run_idx ON reconciliation_issues (run_id, issue_type);
