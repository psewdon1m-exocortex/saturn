ALTER TABLE shares
  ADD COLUMN token_ciphertext text;

COMMENT ON COLUMN shares.token_ciphertext IS
  'AES-256-GCM protected share capability. NULL identifies a legacy hash-only share that requires owner-initiated replacement before it can be copied.';
