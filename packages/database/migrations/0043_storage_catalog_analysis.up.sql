CREATE TABLE storage_catalog_jobs (
  id uuid PRIMARY KEY,
  profile_id text NOT NULL,
  profile_revision bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','analyzing','ready','sync_queued','syncing','synchronized','stale','failed')),
  scanned_entries bigint NOT NULL DEFAULT 0,
  scanned_bytes bigint NOT NULL DEFAULT 0,
  current_path text,
  counts jsonb NOT NULL DEFAULT '{"added":0,"changed":0,"missing":0,"blocked":0}',
  plan jsonb,
  failure_code text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX storage_catalog_single_job ON storage_catalog_jobs ((1))
  WHERE state IN ('queued','analyzing','sync_queued','syncing');
CREATE INDEX storage_catalog_latest ON storage_catalog_jobs (profile_id,created_at DESC);
