ALTER TABLE backup_services
  ADD COLUMN namespace_slug text,
  ADD COLUMN deployment_id text,
  ADD COLUMN mirror_root text,
  ADD COLUMN mirror_device_id uuid REFERENCES devices(id) ON DELETE SET NULL;

UPDATE backup_services
SET namespace_slug = slug,
    deployment_id = 'default';

ALTER TABLE backup_services
  ALTER COLUMN namespace_slug SET NOT NULL,
  ALTER COLUMN deployment_id SET NOT NULL,
  ADD CONSTRAINT backup_services_namespace_slug_check
    CHECK (namespace_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  ADD CONSTRAINT backup_services_deployment_id_check
    CHECK (deployment_id ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  ADD CONSTRAINT backup_services_mirror_root_check
    CHECK (mirror_root IS NULL OR (mirror_root IN ('volt', 'mastermind') AND namespace_slug = mirror_root)),
  ADD CONSTRAINT backup_services_mirror_device_check
    CHECK (mirror_device_id IS NULL OR mirror_root IS NOT NULL),
  ADD CONSTRAINT backup_services_namespace_deployment_unique
    UNIQUE (namespace_slug, deployment_id);

CREATE UNIQUE INDEX backup_services_active_mirror_root_unique
  ON backup_services(mirror_root)
  WHERE mirror_root IS NOT NULL AND state = 'active';

CREATE FUNCTION vault_revoke_neptune_mirror_device() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.mirror_device_id IS NOT NULL
     AND (NEW.state <> 'active' OR NEW.mirror_device_id IS DISTINCT FROM OLD.mirror_device_id) THEN
    UPDATE devices
    SET state = 'revoked', revoked_at = now(), updated_at = now()
    WHERE id = OLD.mirror_device_id AND state = 'active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER backup_services_revoke_mirror_device
  AFTER UPDATE OF state, mirror_device_id ON backup_services
  FOR EACH ROW EXECUTE FUNCTION vault_revoke_neptune_mirror_device();

CREATE TABLE backup_enrollments (
  id uuid PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES backup_services(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX backup_enrollments_service_idx
  ON backup_enrollments(service_id, created_at DESC);
CREATE INDEX backup_enrollments_active_idx
  ON backup_enrollments(expires_at)
  WHERE consumed_at IS NULL;
