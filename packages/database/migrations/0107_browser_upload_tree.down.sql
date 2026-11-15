-- Do not erase even completed original receipts during rollback.
LOCK TABLE browser_upload_trees,browser_upload_jobs,browser_upload_items IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM browser_upload_trees) OR EXISTS(SELECT 1 FROM drop_uploads WHERE browser_tree_managed) THEN RAISE EXCEPTION 'browser_tree_original_retained'; END IF;
END $$;
DROP TRIGGER browser_upload_drop_identity ON drop_uploads;
DROP TABLE browser_upload_items,browser_upload_jobs,browser_upload_trees;
DROP FUNCTION browser_upload_drop_guard(),browser_upload_identity_guard();
ALTER TABLE drop_uploads DROP COLUMN browser_tree_managed;
