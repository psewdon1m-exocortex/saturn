# Stage 8 — External sharing

Status: `COMPLETE`

## Purpose

Expose an explicitly selected file or folder through a high-entropy,
resource-scoped capability without revealing Storage Box paths or granting any
write authority. The owner controls expiry, password, mode, network scope,
download count and immediate revocation.

## State contract

### Entry state

- Stages 0–7 are `COMPLETE`.
- Stable resource IDs, streaming reads, Range delivery, trash, audit, owner
  recent-proof sessions and public-edge security headers are proven.
- Public traffic still terminates only at Gateway; Storage Box remains private.

### Intermediate state

- `ACTIVE_LOCKED`: token is valid but Argon2id password proof is required.
- `ACTIVE_READY`: token policy, source CIDR, resource state/classification and
  optional share session are valid.
- `BROWSING`: a folder share exposes a sanitized read-only descendant view;
  every requested parent is checked against the immutable share root ID.
- `STREAMING`: Gateway revalidates policy, claims at most one download per
  share session, opens a bounded SFTP range and streams with backpressure.
- `PACKAGING`: a bounded folder tree is turned into a prepared ZIP under
  `_system/packages/<share-id>`; file count, declared bytes and duration are
  checked before and during work.
- `PACKAGE_READY`: the prepared package has an exact size and SHA-256 and can
  be downloaded with Range.
- `REVOKED_OR_BLOCKED`: manual revoke, expiry, download exhaustion, trash,
  missing/quarantined state, source mismatch or stricter classification denies
  new access immediately.

### Exit state

- Share URLs contain at least 128 bits of entropy and no resource ID or path;
  only a domain-separated HMAC is stored.
- Owner list/update/revoke APIs never return a usable token after creation.
- Passwords are stored only as bounded Argon2id hashes; successful proof
  creates a short server-side HttpOnly share session.
- File shares support valid single HTTP byte ranges, `206`, resume and inline
  versus attachment policy without buffering the whole object on Gateway.
- Folder browse cannot escape the share root and never exposes storage paths.
- Prepared folder packages are bounded, checksummed, resumable and removed
  after expiry by maintenance.
- Stable resource IDs keep a share valid across physical moves; trash,
  classification tightening, revoke, expiry and max-download exhaustion deny
  it without deleting owner data.
- Public routes are non-indexable, no-store, read-only and fully audited.

## API contract

```text
POST   /api/v1/shares                         owner
GET    /api/v1/shares                         owner
PATCH  /api/v1/shares/{id}                    owner + recent proof
DELETE /api/v1/shares/{id}                    owner
PATCH  /api/v1/resources/{id}/classification owner + recent proof

GET    /api/v1/public/shares/{token}
POST   /api/v1/public/shares/{token}/unlock
GET    /api/v1/public/shares/{token}/content
GET    /api/v1/public/shares/{token}/children
POST   /api/v1/public/shares/{token}/package
GET    /api/v1/public/shares/{token}/package
```

The canonical browser URL is `/s/<token>`. The browser submits a password only
in a POST body. Tokens/passwords never enter logs, audit details or portable
metadata exports.

Creating a share, including a password-protected share, relies on the active
owner session and does not request the Owner Access Key again. In `browse`
mode folder navigation remains available, while individual downloads are hidden
and the visible `Download all` control is disabled. The public warning explicitly
states that the link has no download permission. The owner-facing Shared list
shows the effective access mode on every collapsed record. In `download_folder`
mode one UI action prepares the bounded package and starts its download; the
POST/GET split remains an internal API detail.

## Defaults and hard bounds

- capability token: 32 random bytes encoded as base64url (256 bits);
- default expiry: 7 days; maximum configurable expiry: 365 days;
- password: optional, 12–128 UTF-8 characters; Argon2id, 19 MiB, two passes;
- share session: 30-minute absolute TTL;
- password failures: 5 per hashed source per 15 minutes;
- one `Range: bytes=start-end` only; invalid/multiple/unsatisfiable ranges are
  rejected without opening storage;
- package: at most 5,000 files, 5 GiB declared bytes and 10 minutes by default;
- public responses and the `/s/` browser page: `noindex`, `noarchive`,
  `no-store`, `nosniff` and deny framing except explicitly sandboxed previews.

## Verification

1. Migration `0007_external_shares` apply/down/apply and recovery export policy.
2. Token entropy/one-time disclosure, enumeration and stable-ID move behavior.
3. Argon2id unlock, source binding, password rate limit and session expiry.
4. Full/partial/invalid Range behavior with exact byte and header checks.
5. View/download disposition and MIME allow-list behavior.
6. Folder descendant browse, sibling/ancestor/traversal denial and secret-child
   filtering.
7. Download-count concurrency and revoke/expiry/trash/classification denial.
8. Prepared package bounds, checksum, Range resume and expiry cleanup.
9. Owner/public browser flows, responsive layout, accessibility and honest
   view-only wording.
10. Runtime log, audit, portable metadata, backup and built-artifact scans for
    known tokens, passwords and session material.

## Rollback

1. Set the global share kill switch off and revoke every active share.
2. Expire share sessions and stop package creation.
3. Delete only `_system/packages` artifacts after their database state is
   marked expired; never delete the underlying owner resources.
4. Roll back UI/API/worker artifacts. Keep stable share/audit rows for forensic
   evidence until the migration is deliberately rolled back.

## Accepted evidence

- Aggregate verifier: `artifacts/verification/stage-08-external-sharing.json`.
- Result: 12/12 check groups passed on 2026-08-26.
- Report SHA-256: `c19304bac32a90cf22a1bdefa1c6c09b19427ef70a34c001fd14d77979eadf45`.
- Desktop screenshot SHA-256: `f877d8a190dc9d5cf389da3c9c280498929d435163162aca3c89aba3ae9809e4`.
- Mobile screenshot SHA-256: `cc27126c9f2ac92ac6d7aeae3a52da20b414e7b6d49470439d7502339c5139dc`.
- The verifier exercised the local PostgreSQL/SFTP topology exclusively through
  Gateway APIs and confirmed cleanup of generated storage objects.
