-- Deliberately refuses rollback while a larger retained stage exists.
ALTER TABLE sync_snapshot_stage DROP CONSTRAINT sync_snapshot_stage_entry_count_check;
ALTER TABLE sync_snapshot_stage ADD CONSTRAINT sync_snapshot_stage_entry_count_check CHECK (entry_count BETWEEN 0 AND 1000000);
