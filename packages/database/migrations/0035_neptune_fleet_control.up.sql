ALTER TABLE backup_services
  DROP CONSTRAINT IF EXISTS backup_services_namespace_deployment_unique;

CREATE UNIQUE INDEX backup_services_active_namespace_deployment_unique
  ON backup_services(namespace_slug, deployment_id)
  WHERE state = 'active';

CREATE TABLE neptune_agents (
  service_id uuid PRIMARY KEY REFERENCES backup_services(id) ON DELETE CASCADE,
  desired_revision bigint NOT NULL DEFAULT 1 CHECK (desired_revision > 0),
  archive_enabled boolean NOT NULL DEFAULT false,
  archive_interval_hours integer NOT NULL DEFAULT 24 CHECK (archive_interval_hours BETWEEN 1 AND 8760),
  mirror_enabled boolean NOT NULL DEFAULT false,
  mirror_interval_minutes integer NOT NULL DEFAULT 5 CHECK (mirror_interval_minutes BETWEEN 1 AND 10080),
  desired_version text,
  client_instance_id text,
  project_id text,
  agent_version text,
  applied_revision bigint NOT NULL DEFAULT 0 CHECK (applied_revision >= 0),
  archive_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  mirror_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  latest_error text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (desired_version IS NULL OR desired_version ~ '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$'),
  CHECK (client_instance_id IS NULL OR length(client_instance_id) BETWEEN 1 AND 128),
  CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 128),
  CHECK (agent_version IS NULL OR length(agent_version) BETWEEN 1 AND 128)
);

CREATE INDEX neptune_agents_last_seen_idx ON neptune_agents(last_seen_at DESC);

CREATE TABLE neptune_agent_commands (
  id uuid PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES backup_services(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('archive.run', 'mirror.run', 'agent.update')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'succeeded', 'failed')),
  error text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK ((state = 'pending' AND completed_at IS NULL) OR (state <> 'pending' AND completed_at IS NOT NULL))
);

CREATE INDEX neptune_agent_commands_delivery_idx
  ON neptune_agent_commands(service_id, created_at)
  WHERE state = 'pending';
