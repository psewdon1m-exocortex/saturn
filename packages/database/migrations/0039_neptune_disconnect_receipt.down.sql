DROP INDEX IF EXISTS neptune_agents_disconnect_token_hash_unique;
ALTER TABLE neptune_agents DROP COLUMN IF EXISTS disconnect_token_hash;
