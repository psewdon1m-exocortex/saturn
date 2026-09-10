CREATE TABLE telegram_binding (
  owner_id text PRIMARY KEY CHECK (owner_id = 'owner'),
  telegram_user_id bigint NOT NULL,
  telegram_chat_id bigint NOT NULL,
  display_name text,
  bound_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE telegram_link_challenges (
  id uuid PRIMARY KEY,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('active', 'consumed', 'revoked', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT telegram_link_challenge_expiry CHECK (expires_at > created_at)
);
CREATE INDEX telegram_link_challenges_active_expiry_idx
  ON telegram_link_challenges (expires_at) WHERE state = 'active';

CREATE TABLE telegram_updates (
  update_id bigint PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  telegram_user_id bigint,
  received_at timestamptz NOT NULL,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_code text
);
CREATE INDEX telegram_updates_state_time_idx ON telegram_updates (state, received_at DESC);

ALTER TABLE owner_preferences
  ALTER COLUMN settings_order
    SET DEFAULT '["appearance", "security", "telegram", "backup", "backup-connections", "updates", "logs"]'::jsonb;

UPDATE owner_preferences AS preferences
SET
  settings_order = (
    SELECT jsonb_agg(ordered.item ORDER BY ordered.position)
    FROM (
      SELECT item.value AS item, item.ordinality::numeric AS position
      FROM jsonb_array_elements(preferences.settings_order) WITH ORDINALITY AS item(value, ordinality)
      UNION ALL
      SELECT
        '"telegram"'::jsonb,
        coalesce(
          (
            SELECT existing.ordinality::numeric + 0.5
            FROM jsonb_array_elements_text(preferences.settings_order) WITH ORDINALITY AS existing(value, ordinality)
            WHERE existing.value = 'security'
          ),
          jsonb_array_length(preferences.settings_order)::numeric + 1
        )
    ) AS ordered
  ),
  updated_at = now()
WHERE NOT settings_order ? 'telegram';
