ALTER TABLE neptune_agents
  ADD COLUMN disconnect_token_hash text
    CHECK (disconnect_token_hash IS NULL OR disconnect_token_hash ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX neptune_agents_disconnect_token_hash_unique
  ON neptune_agents(disconnect_token_hash)
  WHERE disconnect_token_hash IS NOT NULL;
