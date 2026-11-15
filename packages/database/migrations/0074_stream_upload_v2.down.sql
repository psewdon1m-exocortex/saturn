-- A v2 original cannot be downgraded/reinterpreted as a v1 operation.
DO $$ DECLARE saved record; BEGIN
 IF EXISTS(SELECT 1 FROM sync_stream_uploads WHERE input->>'schema'='saturn.stream-upload.v2')
   OR EXISTS(SELECT 1 FROM catalog_guard_roots WHERE (active_runtime->>'maximumFileBytes')::numeric>1073741824)
   OR EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'retained v2 state prevents rollback'; END IF;
 FOR saved IN SELECT definition FROM sync_extension_function_backup WHERE revision=74 LOOP EXECUTE saved.definition; END LOOP;
END $$;
DELETE FROM sync_extension_function_backup WHERE revision=74;
DROP TABLE sync_stream_parts;
DROP FUNCTION sync_stream_part_guard();
