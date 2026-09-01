# Stage 6 — Authenticated owner Web UI

Status: `COMPLETE`

## Purpose

Replace browser use of the bootstrap bearer token with a bounded server-side
owner session, then expose the complete protected file workflow through one
keyboard-operable responsive Web UI.

## State contract

### Entry state

- Stages 0–5 are `COMPLETE`.
- File, version, trash, audit and Saturn recovery contracts are stable.
- The owner bootstrap token exists in a protected runtime file.
- The canonical PROD origin remains an operator input; DEV uses localhost.

### Intermediate state

- `ANONYMOUS`: only health and login are available; protected responses are
  `no-store` and reveal no resource existence.
- `AUTHENTICATING`: a bounded database-backed rate limit is checked before the
  bootstrap access key is compared in constant time.
- `AUTHENTICATED`: a random opaque token exists only in a server-side-hashed
  session row and an HttpOnly cookie; a separate CSRF cookie/header pair is
  required for browser mutations.
- `REAUTHENTICATED`: a rotated session records recent owner proof for critical
  actions. The window is five minutes.
- `REVOKED_OR_EXPIRED`: server-side state rejects the cookie immediately and
  both cookies are cleared.
- `MUTATION_PENDING`: UI controls are disabled, progress is explicit and a
  duplicate action is not issued.
- `MUTATION_FINAL`: the affected collection reloads and a success/error notice
  is announced.

### Exit state

- The browser never stores or sends Storage Box credentials and never retains
  the bootstrap key after login submission.
- Server-side sessions have idle and absolute expiry, rotation, revoke and
  recovery-restore invalidation semantics.
- Every cookie-authenticated mutation requires a matching CSRF header and
  same-origin request.
- Files, Drop Point, Activity, Settings, versions and trash are usable from the UI.
- Upload, create folder, move/rename, copy, download, overwrite, trash and
  restore complete through `FileService`; no UI-only mutation exists.
- Preview is inline only for an explicit MIME allow-list; HTML, SVG, archives,
  office formats and forged MIME fall back to download.
- Desktop, 720 px and 320 px layouts are keyboard operable and meet the root UI
  geometry/theme contract.

## Authentication decision

The already provisioned 256-bit bootstrap access key is used as the initial and
break-glass owner proof. It is exchanged for an opaque server-side session and
is never put in local/session storage or a long-lived Authorization header.
This is a high-entropy access key, not a human password; password hashing rules
do not apply to its file-backed constant-time comparison.

Passkey enrollment remains a supported hardening target once the canonical
PROD RP ID/domain is provisioned. PROD is not exposed with real data until the
domain, TLS and owner factor decision are recorded at Stage 13. Critical
operations already require recent re-authentication, so passkey integration can
replace the proof mechanism without changing session or CSRF boundaries.

## Session and browser policy

- session token: 32 random bytes, only SHA-256 digest stored;
- CSRF token: 32 random bytes, digest in session, raw value in a separate
  SameSite cookie and `X-Vault-CSRF` header;
- idle TTL: 15 minutes; absolute TTL: 12 hours;
- authentication limit: 5 failed attempts per hashed source in 15 minutes;
- production session cookie: `__Host-vault_session`, Secure, HttpOnly,
  SameSite=Strict, Path=/;
- DEV cookie is host-only, HttpOnly, SameSite=Strict and deliberately not
  marked Secure so localhost HTTP remains testable;
- API/private HTML: `Cache-Control: no-store`, CSP, frame denial, MIME sniffing
  denial and no-referrer;
- sessions and rate-limit rows are excluded from Saturn backup data.

## UI contract

- exact user-editable theme inputs: dark, light and accent, defaulting to
  `#000000`, `#ffffff`, `#00a8ff`;
- monospace typography, square single-layer workspaces, no decorative card
  nesting;
- 242 px desktop sidebar and explicit mobile menu at 720 px;
- sticky collection command bar with search first, count, secondary action and
  one primary action;
- custom dialogs for delete/restore/logout-all; no native alert/confirm;
- at most five fixed live notices with stable layout;
- credential fields always open empty and are never application-prefilled.

## Verification

1. Migration `0005_owner_sessions` apply/down/apply.
2. Login success/failure, bounded rate limiting and uniform unauthorized result.
3. Cookie flags, idle/absolute expiry, rotation, logout and revoke-all.
4. CSRF missing/mismatch/cross-origin rejection; bearer machine requests remain
   independent from browser cookies.
5. Re-authentication gate on purge and session revocation.
6. Browser E2E: login, folder, upload, overwrite, versions, move/rename, copy,
   download, trash and restore.
7. Preview allow-list and forged MIME/HTML/SVG negative cases.
8. Keyboard, reduced-motion, 320/720/desktop layout and automated accessibility
   checks.
9. Browser storage, logs, audit and built-artifact scan for known credentials and
   session material.

The accepted report is written to
`artifacts/verification/stage-06-owner-auth-web-ui.json` and its SHA-256 is
`15a8aaa566441c836d524c484e86b9d47f9c8964193e798907bd92358ae70fb1`.

Accepted evidence: 11/11 aggregate checks, including frozen install, lint,
typecheck, all workspace tests, production builds, migration apply/down/apply,
server-side cookie sessions, CSRF and origin rejection, break-glass bearer
separation, recent-proof rotation, MIME-forgery rejection, complete browser
file workflow, server-side revoke-all, the `401,401,401,401,401,429` rate-limit
boundary and a runtime/build secret scan. Axe reported zero serious or critical
violations on the login and authenticated views; browser local/session storage
remained empty.

Visual evidence:

- desktop: `artifacts/verification/stage-06-desktop.png`, SHA-256
  `aeeca3689769c9243cbfd4e9e578ddd7319f3467bcbdd394c3cafd86743a17af`;
- 320 px mobile with the primary menu open:
  `artifacts/verification/stage-06-mobile.png`, SHA-256
  `0ae642ea19a56acc47b1329f7acd31f430dea8545608c053554550892b0e4233`.

## Rollback

- Reverting the Web artifact does not mutate file bytes.
- API rollback first revokes all sessions; the bootstrap bearer path remains an
  operator-only break-glass route during DEV.
- Migration rollback is allowed only after active sessions are revoked.
- File mutations retain the Stage 3/4 operation journal, versions and trash
  rollback behavior.
