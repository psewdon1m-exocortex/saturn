ALTER TABLE backup_services
  ADD COLUMN pipeline_kind text NOT NULL DEFAULT 'service',
  ADD COLUMN pipeline_group_id uuid,
  ADD CONSTRAINT backup_services_pipeline_kind_check
    CHECK (pipeline_kind IN ('host_service', 'service', 'volt', 'mastermind'));

ALTER TABLE backup_services
  DROP CONSTRAINT IF EXISTS backup_services_namespace_deployment_unique;
CREATE UNIQUE INDEX IF NOT EXISTS backup_services_active_namespace_deployment_unique
  ON backup_services(namespace_slug, deployment_id)
  WHERE state = 'active';

UPDATE backup_services
SET pipeline_kind = mirror_root
WHERE mirror_root IN ('volt', 'mastermind');

CREATE INDEX backup_services_pipeline_group_idx
  ON backup_services(pipeline_group_id, created_at DESC)
  WHERE pipeline_group_id IS NOT NULL;

ALTER TABLE devices
  ADD COLUMN device_kind text NOT NULL DEFAULT 'generic',
  ADD COLUMN client_platform text,
  ADD COLUMN client_version text,
  ADD COLUMN last_seen_at timestamptz,
  ADD CONSTRAINT devices_kind_check
    CHECK (device_kind IN ('generic', 'mirror', 'windows_sync')),
  ADD CONSTRAINT devices_client_platform_check
    CHECK (client_platform IS NULL OR client_platform IN ('windows', 'linux'));

UPDATE devices
SET device_kind = 'mirror'
WHERE id IN (
  SELECT mirror_device_id FROM backup_services WHERE mirror_device_id IS NOT NULL
  UNION
  SELECT reader_device_id FROM backup_services WHERE reader_device_id IS NOT NULL
);

UPDATE devices
SET device_kind = 'windows_sync'
WHERE device_kind = 'generic'
  AND scope_ids = ARRAY['00000000-0000-7000-8000-000000000004'::uuid];

CREATE INDEX devices_kind_state_seen_idx
  ON devices(device_kind, state, last_seen_at DESC);

CREATE TABLE device_enrollments (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX device_enrollments_device_idx
  ON device_enrollments(device_id, created_at DESC);
CREATE INDEX device_enrollments_active_idx
  ON device_enrollments(expires_at)
  WHERE consumed_at IS NULL;
