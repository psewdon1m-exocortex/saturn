DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor) OR EXISTS(SELECT 1 FROM sync_backend_tasks) THEN
   RAISE EXCEPTION 'Backend executor evidence must be retained; binary rollback requires compatibility qualification';
 END IF;
END $$;
DROP FUNCTION sync_backend_command(text,jsonb,jsonb);
DROP TABLE sync_backend_read_slots;
DROP TABLE sync_backend_tasks;
DROP TABLE sync_backend_executor;
