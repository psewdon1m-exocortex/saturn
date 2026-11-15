-- A transfer keeps its identity across Range requests and client restarts.
-- Authorization remains in the share/session transaction; this table is not
-- an authority cache. Session deletion also bounds retained claim history.
CREATE TABLE share_download_claims (
  session_id uuid NOT NULL REFERENCES share_sessions(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('content', 'package')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, transfer_id),
  CHECK (expires_at > created_at)
);

CREATE INDEX share_download_claims_expiry_idx
  ON share_download_claims(expires_at, session_id, transfer_id);
