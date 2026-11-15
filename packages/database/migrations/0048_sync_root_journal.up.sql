-- Inactive foundation: no existing root is registered and no writer is enabled.
CREATE TABLE sync_root_clock (
  root_id uuid PRIMARY KEY REFERENCES resources(id),
  epoch uuid NOT NULL,
  published_seq bigint NOT NULL DEFAULT 0 CHECK (published_seq >= 0),
  retained_after_seq bigint NOT NULL DEFAULT 0 CHECK (retained_after_seq >= 0 AND retained_after_seq <= published_seq),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Reuse the recovery/idempotency operation identity; do not create another registry.
ALTER TABLE operation_journal
  ADD COLUMN sync_root_id uuid REFERENCES sync_root_clock(root_id),
  ADD COLUMN sync_epoch uuid,
  ADD COLUMN sync_first_seq bigint,
  ADD COLUMN sync_last_seq bigint,
  ADD COLUMN sync_intent_hash text,
  ADD COLUMN sync_result jsonb,
  ADD CONSTRAINT operation_sync_receipt_shape CHECK (
    (sync_root_id IS NULL AND sync_epoch IS NULL AND sync_first_seq IS NULL AND sync_last_seq IS NULL AND sync_intent_hash IS NULL AND sync_result IS NULL)
    OR (sync_root_id IS NOT NULL AND sync_epoch IS NOT NULL AND sync_intent_hash IS NOT NULL AND sync_intent_hash ~ '^[a-f0-9]{64}$'
      AND ((sync_first_seq IS NULL AND sync_last_seq IS NULL AND sync_result IS NULL)
        OR (sync_first_seq IS NOT NULL AND sync_last_seq IS NOT NULL AND sync_first_seq > 0
          AND sync_last_seq >= sync_first_seq AND sync_result IS NOT NULL AND state = 'active')))
  );

CREATE TABLE sync_root_changes (
  root_id uuid NOT NULL REFERENCES sync_root_clock(root_id),
  epoch uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  node_id uuid NOT NULL,
  operation_id uuid NOT NULL REFERENCES operation_journal(id),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 8192),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_id, epoch, seq)
);

-- Compact receipts live for the root's lifetime, including retired epochs.
-- Legacy status/cleanup code must never make a published operation executable again.
CREATE FUNCTION guard_sync_operation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sync_root_id IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Bound sync operation cannot be deleted' USING ERRCODE = '55000';
    END IF;
    IF ROW(NEW.sync_root_id,NEW.sync_epoch,NEW.sync_intent_hash) IS DISTINCT FROM ROW(OLD.sync_root_id,OLD.sync_epoch,OLD.sync_intent_hash)
      OR (OLD.sync_result IS NOT NULL AND (NEW.state <> 'active' OR ROW(NEW.sync_first_seq,NEW.sync_last_seq,NEW.sync_result)
        IS DISTINCT FROM ROW(OLD.sync_first_seq,OLD.sync_last_seq,OLD.sync_result))) THEN
      RAISE EXCEPTION 'Published sync receipt is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operation_sync_receipt_guard BEFORE UPDATE OR DELETE ON operation_journal
  FOR EACH ROW EXECUTE FUNCTION guard_sync_operation_receipt();
