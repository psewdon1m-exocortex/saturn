ALTER TABLE backup_services
  ADD COLUMN reader_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  ADD CONSTRAINT backup_services_reader_device_check
    CHECK (reader_device_id IS NULL OR (namespace_slug = 'mastermind' AND mirror_root = 'mastermind'));

CREATE FUNCTION vault_revoke_neptune_reader_device() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reader_device_id IS NOT NULL
     AND (NEW.state <> 'active' OR NEW.reader_device_id IS DISTINCT FROM OLD.reader_device_id) THEN
    UPDATE devices SET state = 'revoked', revoked_at = now(), updated_at = now()
    WHERE id = OLD.reader_device_id AND state = 'active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER backup_services_revoke_reader_device
  AFTER UPDATE OF state, reader_device_id ON backup_services
  FOR EACH ROW EXECUTE FUNCTION vault_revoke_neptune_reader_device();
