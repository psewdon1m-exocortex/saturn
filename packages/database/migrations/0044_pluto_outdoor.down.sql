DO $$ BEGIN IF EXISTS(SELECT 1 FROM devices WHERE device_kind='pluto') THEN RAISE EXCEPTION 'Remove Pluto identities explicitly before rollback; stored files are preserved'; END IF; END $$;
ALTER TABLE devices DROP CONSTRAINT devices_pluto_root_check;
ALTER TABLE devices DROP COLUMN pluto_status;
ALTER TABLE devices DROP CONSTRAINT devices_kind_check;
ALTER TABLE devices ADD CONSTRAINT devices_kind_check CHECK (device_kind IN ('generic','mirror','windows_sync'));
