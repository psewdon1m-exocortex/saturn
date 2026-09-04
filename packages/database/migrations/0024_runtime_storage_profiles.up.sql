CREATE TABLE storage_switches (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL UNIQUE,
  previous_profile_id text NOT NULL,
  host text NOT NULL CHECK (length(btrim(host)) BETWEEN 1 AND 255),
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username text NOT NULL CHECK (length(btrim(username)) BETWEEN 1 AND 255),
  root text NOT NULL CHECK (length(root) BETWEEN 1 AND 1024),
  auth_mode text NOT NULL CHECK (auth_mode IN ('password_file', 'private_key_file')),
  host_fingerprint text NOT NULL CHECK (host_fingerprint ~ '^SHA256:[A-Za-z0-9+/]{43}=?$'),
  directory_count bigint NOT NULL CHECK (directory_count >= 0),
  file_count bigint NOT NULL CHECK (file_count >= 0),
  indexed_bytes bigint NOT NULL CHECK (indexed_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX storage_switches_created_idx ON storage_switches(created_at DESC);

INSERT INTO system_metadata(key, value)
VALUES ('active_storage_profile', '{"profileId":"bootstrap","revision":1,"source":"bootstrap"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
