DROP TRIGGER sync_snapshot_retention_guard ON sync_root_clock;
DROP FUNCTION guard_sync_snapshot_retention();
DROP TABLE sync_snapshot_frontier;
DROP TABLE sync_snapshot_entries;
DROP TABLE sync_snapshot_stage;
DROP INDEX resources_active_parent_id_cursor;
