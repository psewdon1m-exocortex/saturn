ALTER TABLE owner_preferences
  ADD COLUMN dashboard_order jsonb NOT NULL
    DEFAULT '["cpu", "ram", "disk", "uptime"]'::jsonb
    CHECK (jsonb_typeof(dashboard_order) = 'array'),
  ADD COLUMN settings_order jsonb NOT NULL
    DEFAULT '["appearance", "security", "backup", "updates", "logs"]'::jsonb
    CHECK (jsonb_typeof(settings_order) = 'array');

CREATE TABLE owner_credentials (
  owner_id text PRIMARY KEY CHECK (owner_id = 'owner'),
  algorithm text NOT NULL CHECK (algorithm = 'scrypt-v1'),
  salt_hex text NOT NULL CHECK (salt_hex ~ '^[a-f0-9]{32}$'),
  verifier_hex text NOT NULL CHECK (verifier_hex ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kernel_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  kernel_url text,
  public_identity text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO kernel_settings (singleton) VALUES (true);

UPDATE owner_preferences
SET
  dark_color = '#000000',
  light_color = '#ffffff',
  navigation_order = (
    SELECT jsonb_agg(destination ORDER BY ordinal)
    FROM (
      SELECT 'dashboard'::text AS destination, 0::bigint AS ordinal
      UNION ALL
      SELECT item.destination, item.ordinal
      FROM jsonb_array_elements_text(navigation_order) WITH ORDINALITY AS item(destination, ordinal)
      WHERE item.destination IN ('files', 'inbox', 'shared', 'trash', 'settings')
    ) ordered
  ),
  dashboard_order = '["cpu", "ram", "disk", "uptime"]'::jsonb,
  settings_order = '["appearance", "security", "backup", "updates", "logs"]'::jsonb,
  updated_at = now();

ALTER TABLE owner_preferences
  ALTER COLUMN navigation_order
    SET DEFAULT '["dashboard", "files", "inbox", "shared", "trash", "settings"]'::jsonb;
