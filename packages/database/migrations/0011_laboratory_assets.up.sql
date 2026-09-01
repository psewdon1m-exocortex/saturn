CREATE TABLE laboratory_clients (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  previous_token_hash char(64) UNIQUE CHECK (previous_token_hash IS NULL OR previous_token_hash ~ '^[a-f0-9]{64}$'),
  previous_token_expires_at timestamptz,
  state text NOT NULL CHECK (state IN ('active','revoked')),
  last_used_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK ((previous_token_hash IS NULL) = (previous_token_expires_at IS NULL))
);
CREATE INDEX laboratory_clients_state_idx ON laboratory_clients(state, created_at DESC);

CREATE TABLE laboratory_assets (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES resources(id),
  mode text NOT NULL CHECK (mode IN ('private','public_immutable','public_alias')),
  pinned_version_id uuid REFERENCES file_versions(id),
  public_filename text NOT NULL CHECK (length(public_filename) BETWEEN 1 AND 255 AND public_filename = btrim(public_filename) AND position('/' in public_filename)=0 AND position(chr(92) in public_filename)=0 AND public_filename !~ '[[:cntrl:]]'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 240 AND label !~ '[[:cntrl:]]'),
  disposition text NOT NULL CHECK (disposition IN ('inline','attachment')),
  state text NOT NULL CHECK (state IN ('active','disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  disabled_at timestamptz,
  CHECK ((mode = 'public_immutable' AND pinned_version_id IS NOT NULL) OR (mode <> 'public_immutable' AND pinned_version_id IS NULL))
);
CREATE INDEX laboratory_assets_resource_idx ON laboratory_assets(resource_id, state);
CREATE INDEX laboratory_assets_pinned_version_idx ON laboratory_assets(pinned_version_id) WHERE state='active';

CREATE FUNCTION vault_validate_laboratory_asset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_resource resources%ROWTYPE;
BEGIN
  SELECT * INTO selected_resource FROM resources WHERE id=NEW.resource_id;
  IF NOT FOUND OR selected_resource.type <> 'file' OR selected_resource.status <> 'active' THEN
    RAISE EXCEPTION 'laboratory resource is not an active file' USING ERRCODE='23514';
  END IF;
  IF selected_resource.storage_path = 'drive/Passwords' OR selected_resource.storage_path LIKE 'drive/Passwords/%' THEN
    RAISE EXCEPTION 'password resources cannot be laboratory assets' USING ERRCODE='23514';
  END IF;
  IF NEW.mode LIKE 'public_%' AND selected_resource.security_classification IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'public laboratory asset requires public classification' USING ERRCODE='23514';
  END IF;
  IF NEW.pinned_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM file_versions WHERE id=NEW.pinned_version_id AND resource_id=NEW.resource_id AND state='active'
  ) THEN RAISE EXCEPTION 'laboratory pinned version is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_assets_validate BEFORE INSERT OR UPDATE OF resource_id,mode,pinned_version_id ON laboratory_assets FOR EACH ROW EXECUTE FUNCTION vault_validate_laboratory_asset();
