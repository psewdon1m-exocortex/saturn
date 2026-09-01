INSERT INTO resources (id, type, parent_id, name, storage_path, status, security_classification)
VALUES
  ('00000000-0000-7000-8000-000000000003', 'folder', '00000000-0000-7000-8000-000000000001', 'mastermind', 'drive/mastermind', 'active', 'internal'),
  ('00000000-0000-7000-8000-000000000004', 'folder', '00000000-0000-7000-8000-000000000001', 'Sync', 'drive/Sync', 'active', 'internal'),
  ('00000000-0000-7000-8000-000000000005', 'folder', '00000000-0000-7000-8000-000000000001', 'Passwords', 'drive/Passwords', 'active', 'confidential')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  scope_ids uuid[] NOT NULL CHECK (cardinality(scope_ids) BETWEEN 1 AND 3),
  can_read boolean NOT NULL,
  can_write boolean NOT NULL,
  can_move boolean NOT NULL,
  can_delete boolean NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (can_read OR can_write OR can_move OR can_delete)
);
CREATE INDEX devices_state_expiry_idx ON devices (state, expires_at);

CREATE TABLE device_delete_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  item_count integer NOT NULL CHECK (item_count > 0),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX device_delete_events_window_idx ON device_delete_events (device_id, occurred_at DESC);

CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  resource_id uuid NOT NULL REFERENCES resources(id),
  conflict_resource_id uuid NOT NULL REFERENCES resources(id),
  base_etag text NOT NULL,
  current_etag text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX sync_conflicts_resource_state_idx ON sync_conflicts (resource_id, state, created_at DESC);

CREATE FUNCTION vault_apply_resource_path_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_path = 'drive/Passwords' OR NEW.storage_path LIKE 'drive/Passwords/%' THEN
    NEW.security_classification := 'confidential';
    IF NEW.type = 'file' AND lower(NEW.name) LIKE '%.kdbx' THEN
      NEW.retention_class := 'keepass';
    END IF;
  ELSIF NEW.storage_path LIKE 'drive/mastermind/%' AND NEW.type = 'file' THEN
    NEW.retention_class := CASE WHEN lower(NEW.name) LIKE '%.md'
      THEN 'mastermind_markdown' ELSE 'mastermind_attachment' END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resources_path_policy
  BEFORE INSERT OR UPDATE OF storage_path, name ON resources
  FOR EACH ROW EXECUTE FUNCTION vault_apply_resource_path_policy();
