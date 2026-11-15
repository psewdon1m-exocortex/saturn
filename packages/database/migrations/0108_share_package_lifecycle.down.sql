-- Downgrade only after all generation objects/readers have been conclusively
-- reclaimed. Never discard records that own potentially live backend paths.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM share_package_generations) OR EXISTS(SELECT 1 FROM share_package_read_leases) THEN
    RAISE EXCEPTION 'share package generations must be reclaimed before downgrade';
  END IF;
END $$;
ALTER TABLE share_packages DROP COLUMN generation_id;
DROP TABLE share_package_read_leases;
DROP TABLE share_package_generations;
