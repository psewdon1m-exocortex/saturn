CREATE TABLE IF NOT EXISTS system_metadata (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  role text PRIMARY KEY,
  instance_id text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  CONSTRAINT worker_heartbeats_role_not_blank CHECK (length(btrim(role)) > 0),
  CONSTRAINT worker_heartbeats_instance_not_blank CHECK (length(btrim(instance_id)) > 0)
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_last_seen_idx
  ON worker_heartbeats (last_seen_at DESC);
