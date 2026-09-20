-- Keep the existing authoritative records and intervals. Only new profiles
-- receive the new default; existing short mirror intervals remain exact.
ALTER TABLE neptune_agents ADD COLUMN policy_paused boolean NOT NULL DEFAULT false;
ALTER TABLE neptune_agents ALTER COLUMN mirror_interval_minutes SET DEFAULT 1440;
CREATE TABLE neptune_policy_operations (
  service_id uuid NOT NULL REFERENCES backup_services(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(service_id, request_id)
);
