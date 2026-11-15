-- Cardinality is bounded by retained bytes and bounded page transactions, not
-- an arbitrary one-million-row ceiling. Existing snapshots/cursors stay valid.
ALTER TABLE sync_snapshot_stage DROP CONSTRAINT sync_snapshot_stage_entry_count_check;
ALTER TABLE sync_snapshot_stage ADD CONSTRAINT sync_snapshot_stage_entry_count_check CHECK (entry_count >= 0);
