ALTER TABLE backup_services
  ADD COLUMN archive_pipeline boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT backup_services_selected_pipeline_check
    CHECK (archive_pipeline OR mirror_root IS NOT NULL);

ALTER TABLE devices ADD COLUMN sync_root_id uuid REFERENCES resources(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX devices_sync_root_unique ON devices(sync_root_id)
  WHERE sync_root_id IS NOT NULL;

-- Existing Windows credentials have no proven folder ownership. They remain
-- visible for owner recovery but authorization fails closed until re-enrollment.
