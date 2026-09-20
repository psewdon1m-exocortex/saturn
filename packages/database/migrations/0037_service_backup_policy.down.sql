-- Refuse to reactivate restored schedules without their verification state.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM neptune_agents WHERE policy_paused) THEN
    RAISE EXCEPTION 'Resolve paused restored policies before rolling back policy storage';
  END IF;
END $$;
DROP TABLE neptune_policy_operations;
ALTER TABLE neptune_agents ALTER COLUMN mirror_interval_minutes SET DEFAULT 5;
ALTER TABLE neptune_agents DROP COLUMN policy_paused;
