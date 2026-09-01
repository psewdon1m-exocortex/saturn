CREATE TABLE backup_runs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('scheduled', 'manual', 'pre_restore', 'restore_drill')),
  state text NOT NULL CHECK (state IN ('preparing', 'validating', 'complete', 'failed')),
  archive_path text,
  archive_sha256 text CHECK (archive_sha256 IS NULL OR archive_sha256 ~ '^[a-f0-9]{64}$'),
  archive_bytes bigint CHECK (archive_bytes IS NULL OR archive_bytes >= 0),
  member_count integer CHECK (member_count IS NULL OR member_count >= 0),
  database_dump_sha256 text CHECK (database_dump_sha256 IS NULL OR database_dump_sha256 ~ '^[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_code text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX backup_runs_started_idx ON backup_runs (started_at DESC);
CREATE UNIQUE INDEX backup_runs_single_active_idx
  ON backup_runs ((1)) WHERE state IN ('preparing', 'validating');

CREATE TABLE recovery_runs (
  id uuid PRIMARY KEY,
  backup_run_id uuid REFERENCES backup_runs(id),
  mode text NOT NULL CHECK (mode IN ('clean', 'replace', 'drill')),
  state text NOT NULL CHECK (state IN (
    'validating', 'snapshotting', 'applying', 'verifying',
    'complete', 'rolled_back', 'failed'
  )),
  snapshot_backup_id uuid REFERENCES backup_runs(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  measured_rpo_ms bigint CHECK (measured_rpo_ms IS NULL OR measured_rpo_ms >= 0),
  measured_rto_ms bigint CHECK (measured_rto_ms IS NULL OR measured_rto_ms >= 0),
  error_code text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX recovery_runs_started_idx ON recovery_runs (started_at DESC);
CREATE UNIQUE INDEX recovery_runs_single_active_idx
  ON recovery_runs ((1))
  WHERE state IN ('validating', 'snapshotting', 'applying', 'verifying');

