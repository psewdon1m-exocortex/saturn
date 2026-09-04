# Stage 7 — Telegram owner binding and Drop Point

Status: `COMPLETE`

## Purpose

Bind one stable Telegram user identity to the owner through an explicit
one-time ceremony, then issue short-lived upload-only Drop sessions that can
write new files into a server-selected `drop point` date folder without gaining any
read, list, overwrite, move or delete capability.

## State contract

### Entry state

- Stages 0–6 are `COMPLETE`.
- Owner login, recent re-authentication, audit, resumable uploads, Drop Point and
  server-side secret files are stable.
- The runtime can inject a Telegram bot token and webhook secret. DEV uses a
  protocol-faithful local provider; a real token and canonical HTTPS origin are
  production inputs owned by Stage 13.

### Intermediate state

- `UNBOUND`: Telegram commands cannot issue Drop access.
- `LINK_CHALLENGE_ACTIVE`: a recently re-authenticated owner has generated a
  purpose-bound, short-lived, single-use link code. Only its domain-separated
  HMAC is stored.
- `BOUND`: one Telegram `from.id` and its private `chat.id` are bound
  transactionally. Usernames are display metadata and never identity.
- `DROP_CHALLENGE_ACTIVE`: `/drop` from the bound identity creates one
  Crockford Base32 code and one shared Drop channel. Its raw value exists only
  in the provider message and remains redeemable during the bounded admission
  window so several devices can join the same channel.
- `DROP_SESSION_ACTIVE`: every successful redemption creates independent
  HttpOnly and CSRF credentials for that client. All clients joined with the
  same code share the channel's absolute expiry, upload list and quota.
- `UPLOAD_RESERVED`: a file slot and its declared bytes are reserved before a
  core upload is created. Reservation is rolled back if creation fails.
- `UPLOADING`: only upload IDs mapped to the authenticated Drop channel may be
  listed, inspected, resumed or cancelled.
- `COMPLETED`: `FileService` has atomically committed and checksummed the file
  under `drop point/YYYY-MM-DD`; the completion is idempotent.
- `REVOKED_OR_EXPIRED`: the Drop cookie, every active session and every pending
  Drop challenge are rejected immediately.
- `UPDATE_CLAIMED`: a webhook `update_id` is claimed transactionally; completed
  updates are deduplicated and failed delivery can be retried deliberately.

### Exit state

- Only the currently bound stable Telegram identity in a private chat can use
  `/drop`, `/revoke` or `/status`.
- Link and Drop codes have different alphabets/lengths, HMAC domains, database
  purpose values and redemption functions. Link codes remain single-use; a
  Drop code deliberately admits multiple clients only until its code TTL.
- A Drop client can create, resume, inspect and complete only its channel's
  uploads. File and byte quotas are atomic and shared by that whole channel.
- Drop routes expose no resource IDs beyond the session's upload mappings and
  no list, read, overwrite, rename, move, copy, trash or restore operation.
- Invalid redeem attempts are bounded per source and globally in a 15-minute
  database window. Codes never appear in URLs, cookies, logs or backups.
- The webhook accepts only HTTPS-registered Telegram `message` updates with a
  constant-time-validated secret header and deduplicates by `update_id`.
- `/revoke` invalidates pending Drop codes and all active Drop sessions without
  changing committed owner files.

## Public and owner API contract

```text
POST   /api/v1/telegram/link-challenges       owner + recent proof
GET    /api/v1/telegram/status                owner
DELETE /api/v1/telegram/binding               owner + recent proof

POST   /internal/telegram/webhook             Telegram secret header

POST   /api/v1/drop/redeem                    code + same-origin POST
GET    /api/v1/drop/session                   Drop cookie; quota state only
GET    /api/v1/drop/events                    Drop cookie; channel upload SSE
GET    /api/v1/drop/uploads                   Drop cookie; channel uploads only
POST   /api/v1/drop/uploads                   Drop cookie + CSRF
GET    /api/v1/drop/uploads/{id}/status       channel-mapped upload only
PATCH  /api/v1/drop/uploads/{id}              channel-mapped upload only
POST   /api/v1/drop/complete                  channel-mapped upload only
POST   /api/v1/drop/logout                    revoke current Drop session
```

`/drop` is a public, non-indexable page. The code is accepted only in the POST
body. The browser stores no code or token in local/session storage. A non-secret
channel UUID in the tab's History state prevents another tab's same-origin
cookie from silently switching that tab to a different Drop channel.

## Defaults and hard bounds

- link code: 12 Crockford Base32 characters, 5-minute TTL, single use;
- Drop code: 8 Crockford Base32 characters, 30-minute multi-client admission window;
- Drop channel and every client session: the same absolute expiry, exactly 30
  minutes after code issue; a late redemption never extends it;
- maximum 1,000 files and 100 GiB declared bytes per channel;
- invalid redeem limit: 5 per hashed source and 100 globally per 15 minutes;
- webhook JSON body: 64 KiB; accepted update type: `message` only;
- provider request timeout: 10 seconds; no bot token is included in surfaced
  errors or logs.

## Provider lifecycle

When Telegram delivery is enabled, API startup calls `getMe`, verifies that the
returned identity is a bot, and registers exactly one webhook with
`allowed_updates=["message"]`, the configured secret token and bounded
connection count. A failed validation leaves Telegram degraded and prevents
unsafe command handling; owner file APIs remain independent. Production uses
`https://api.telegram.org`; a custom base URL is accepted only for the DEV/test
provider harness.

## Verification

1. Migration `0006_telegram_drop` apply/down/apply.
2. Distinct link/Drop lifecycle, expiry, purpose swapping and concurrent
   multi-client redemption into one shared channel.
3. Bound/unbound/forged Telegram identities, private-chat enforcement, webhook
   secret mismatch, update replay and provider retry behavior.
4. Per-source and global brute-force boundaries, session expiry and `/revoke`.
5. Complete browser Drop E2E: redeem, interrupted chunk upload, resume,
   checksum commit and owner Drop Point visibility.
6. Negative privilege matrix against owner list/read/overwrite/delete routes
   and another Drop channel's upload IDs.
7. File-count and byte quota concurrency tests with reservation rollback.
8. Telegram provider `getMe`, `setWebhook` and `sendMessage` contract through a
   local HTTP server, including timeout/error redaction.
9. Browser accessibility/responsive checks, cache/indexing headers and scans of
   logs, backup output and built artifacts for known codes/tokens/secrets.

## Rollback

1. Disable Telegram delivery and rotate the provider webhook secret/token.
2. Revoke the binding, all Drop challenges and all Drop sessions.
3. Let mapped incomplete core uploads expire or reconcile them normally.
4. Roll back the web/API artifact. Committed Drop Point files remain ordinary owner
   files and are never removed by integration rollback.
5. Migration rollback is allowed only after ephemeral rows are revoked and DEV
   upload mappings have been cleaned.

## Accepted evidence

- `artifacts/verification/stage-07-telegram-drop.json`: 16/16 checks passed.
- Report SHA-256: `34cd9941d7436be0baed59a022874e01f924abc304c021d033daa7f9459c3b1e`.
- Desktop screenshot SHA-256: `ac8d1daa16863a872c0608cf7765cfa8f6e8b88da1a8fa1779cde56bc44f2450`.
- Mobile screenshot SHA-256: `71c94b163ab10eba51a2ef74bf9e5709cfe452e023f169c4ec85e8988df2ce0d`.
- Accepted on 2026-08-26 after migration rollback/apply, provider registration,
  identity and replay checks, interrupted upload restart/resume, checksum
  readback, negative privilege tests, concurrent quota/rate boundaries,
  browser/Axe checks and exact-secret scans of logs, artifacts and backup data.
