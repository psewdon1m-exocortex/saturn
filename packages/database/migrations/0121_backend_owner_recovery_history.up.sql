-- Private operator evidence only. Runtime/writer connections get no authority.
CREATE SCHEMA saturn_owner_recovery;
REVOKE ALL ON SCHEMA saturn_owner_recovery FROM PUBLIC;
CREATE TABLE saturn_owner_recovery.history (
 id uuid PRIMARY KEY, proof_sha256 text NOT NULL CHECK(proof_sha256 ~ '^[a-f0-9]{64}$'),
 proof jsonb NOT NULL, receipt jsonb NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON saturn_owner_recovery.history FROM PUBLIC;
CREATE FUNCTION saturn_owner_recovery.immutable_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'owner_recovery_history_retained'; END $$;
CREATE TRIGGER retain_history BEFORE UPDATE OR DELETE ON saturn_owner_recovery.history FOR EACH ROW EXECUTE FUNCTION saturn_owner_recovery.immutable_history();
CREATE TRIGGER retain_all_history BEFORE TRUNCATE ON saturn_owner_recovery.history FOR EACH STATEMENT EXECUTE FUNCTION saturn_owner_recovery.immutable_history();
REVOKE ALL ON FUNCTION saturn_owner_recovery.immutable_history() FROM PUBLIC;
