DO $$ BEGIN IF EXISTS(SELECT 1 FROM sync_stream_uploads) THEN RAISE EXCEPTION 'Streaming originals must be retained'; END IF; END $$;
DROP FUNCTION sync_stream_command(text,jsonb,jsonb,jsonb);
DROP TABLE sync_stream_uploads;
DROP FUNCTION sync_stream_original_guard();
