CREATE TABLE archive_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('compress_zip', 'extract')),
  format text NOT NULL CHECK (format IN ('zip', 'rar')),
  state text NOT NULL CHECK (state IN (
    'queued', 'scanning', 'compressing', 'extracting', 'verifying',
    'committing', 'paused', 'completed', 'failed', 'cancelled'
  )),
  requested_state text NOT NULL DEFAULT 'running' CHECK (requested_state IN ('running', 'paused', 'cancelled')),
  destination_parent_id uuid NOT NULL REFERENCES resources(id),
  source_resource_id uuid REFERENCES resources(id),
  source_resource_ids uuid[] NOT NULL DEFAULT '{}',
  output_name text NOT NULL CHECK (length(btrim(output_name)) > 0),
  total_bytes bigint NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  processed_bytes bigint NOT NULL DEFAULT 0 CHECK (processed_bytes >= 0),
  current_item text,
  result_resource_id uuid REFERENCES resources(id),
  failure_code text,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT archive_jobs_kind_source CHECK (
    (kind = 'compress_zip' AND source_resource_id IS NULL AND cardinality(source_resource_ids) > 0 AND format = 'zip')
    OR
    (kind = 'extract' AND source_resource_id IS NOT NULL AND cardinality(source_resource_ids) = 0)
  )
);

CREATE INDEX archive_jobs_claim_idx
  ON archive_jobs (requested_state, state, lease_expires_at, created_at)
  WHERE state NOT IN ('completed', 'failed', 'cancelled');

CREATE INDEX archive_jobs_destination_idx
  ON archive_jobs (destination_parent_id, created_at DESC);
