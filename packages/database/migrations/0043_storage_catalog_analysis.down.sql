DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM storage_catalog_jobs WHERE state IN ('queued','analyzing','sync_queued','syncing')) THEN
    RAISE EXCEPTION 'Finish storage catalog jobs before rolling back';
  END IF;
END $$;
DROP TABLE storage_catalog_jobs;
