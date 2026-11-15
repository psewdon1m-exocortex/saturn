DO $$ BEGIN IF EXISTS(SELECT 1 FROM saturn_owner_recovery.history) THEN RAISE EXCEPTION 'owner_recovery_history_retained'; END IF; END $$;
DROP TRIGGER retain_all_history ON saturn_owner_recovery.history;
DROP TRIGGER retain_history ON saturn_owner_recovery.history;
DROP FUNCTION saturn_owner_recovery.immutable_history();
DROP TABLE saturn_owner_recovery.history;
DROP SCHEMA saturn_owner_recovery;
