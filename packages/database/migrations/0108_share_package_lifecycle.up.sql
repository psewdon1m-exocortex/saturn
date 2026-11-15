-- D04 draft: N01 integrates after reviewing consumer tests. Drain old binaries
-- before rollout. A legacy path is uncertain, never reclaimed merely by age.
CREATE TABLE share_package_generations (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES share_packages(id) ON DELETE RESTRICT,
  storage_path text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('writing','ready','retired','deleting')),
  writer_token uuid,
  writer_state text NOT NULL CHECK (writer_state IN ('UNKNOWN_WRITER','CLOSED_RECLAIMABLE')),
  writer_expires_at timestamptz NOT NULL,
  writer_closed_at timestamptz,
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cleanup_token uuid,
  cleanup_expires_at timestamptz,
  UNIQUE(package_id,id),
  CHECK ((writer_state='CLOSED_RECLAIMABLE') = (writer_closed_at IS NOT NULL)),
  CHECK (state NOT IN ('ready','deleting') OR writer_state='CLOSED_RECLAIMABLE'),
  CHECK ((state='deleting') = (cleanup_token IS NOT NULL AND cleanup_expires_at IS NOT NULL))
);
CREATE INDEX share_package_generations_package_idx ON share_package_generations(package_id);
CREATE INDEX share_package_generations_cleanup_idx ON share_package_generations(state,writer_expires_at,created_at);
ALTER TABLE share_packages ADD COLUMN generation_id uuid;
ALTER TABLE share_packages ADD CONSTRAINT share_package_generation_owner_fk
  FOREIGN KEY(id,generation_id) REFERENCES share_package_generations(package_id,id) ON DELETE RESTRICT;

CREATE TABLE share_package_read_leases (
  id uuid PRIMARY KEY,
  generation_id uuid NOT NULL REFERENCES share_package_generations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at)
);
CREATE INDEX share_package_read_leases_generation_idx ON share_package_read_leases(generation_id);
-- Expired readers remain recorded until explicit stream closure. We make no
-- blanket promise that unlinking an open handle is safe on every SFTP server.

INSERT INTO share_package_generations(id,package_id,storage_path,state,writer_state,writer_expires_at,reserved_bytes)
SELECT gen_random_uuid(),id,storage_path,'retired','UNKNOWN_WRITER',clock_timestamp(),greatest(size_bytes,5368709120)
FROM share_packages;
UPDATE share_packages SET state='expired',error_code='legacy_package_custody_unknown'
WHERE state IN ('preparing','ready','failed');

-- Existing adopted runtime roles predate these tables. Grant only ordinary
-- service DML; writer logins retain their fixed-function-only contract.
DO $runtime_grants$
DECLARE runtime_name text;
BEGIN
 FOR runtime_name IN SELECT DISTINCT runtime_role FROM public.catalog_guard_roots LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.share_package_generations,public.share_package_read_leases,public.share_download_claims TO %I',runtime_name);
 END LOOP;
END $runtime_grants$;
