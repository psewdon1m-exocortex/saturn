ALTER TABLE devices DROP CONSTRAINT devices_kind_check;
ALTER TABLE devices ADD CONSTRAINT devices_kind_check CHECK (device_kind IN ('generic','mirror','windows_sync','pluto'));
ALTER TABLE devices ADD COLUMN pluto_status jsonb;
ALTER TABLE devices ADD CONSTRAINT devices_pluto_root_check CHECK (device_kind <> 'pluto' OR (sync_root_id IS NOT NULL AND scope_ids = ARRAY[sync_root_id] AND can_read AND can_write AND NOT can_move AND NOT can_delete));
