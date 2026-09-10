CREATE TABLE gryphon_events (
  event_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX gryphon_events_created_at_idx ON gryphon_events(created_at);
