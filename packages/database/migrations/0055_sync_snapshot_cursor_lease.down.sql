-- Downgrade refuses active cursor-bearing sessions rather than discarding them.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sync_snapshot_cursor) THEN
    RAISE EXCEPTION 'Snapshot cursors must be expired and collected before downgrade' USING ERRCODE='55000';
  END IF;
END $$;
DROP TRIGGER sync_snapshot_header_immutable ON sync_snapshot_stage;
DROP FUNCTION guard_ready_snapshot_header();
DROP TRIGGER sync_snapshot_entries_no_truncate ON sync_snapshot_entries;
DROP FUNCTION guard_snapshot_entries_truncate();
DROP TRIGGER sync_snapshot_entries_immutable ON sync_snapshot_entries;
DROP FUNCTION guard_ready_snapshot_entries();
DROP TABLE sync_snapshot_cursor;
ALTER TABLE sync_snapshot_stage DROP COLUMN cursor_count,DROP COLUMN changes_cursor,DROP COLUMN entries_cursor;
DO $snapshot_cursor_uninstall$ BEGIN
EXECUTE replace($snapshot_cursor_ddl$
CREATE OR REPLACE FUNCTION guard_sync_snapshot_retention() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.retained_after_seq > OLD.retained_after_seq AND EXISTS (
    SELECT 1 FROM public.sync_snapshot_stage s
    WHERE s.root_id = OLD.root_id AND s.epoch = OLD.epoch
      AND s.state IN ('BASE','OVERLAY') AND s.start_seq < NEW.retained_after_seq
      AND s.lease_until > clock_timestamp() AND s.absolute_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Retained prefix is pinned by an unfinished snapshot' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
$snapshot_cursor_ddl$,'public.',quote_ident(current_schema())||'.');
END $snapshot_cursor_uninstall$;
