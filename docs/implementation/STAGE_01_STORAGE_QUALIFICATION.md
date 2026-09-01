# Stage 1 — DEV Storage Box qualification

Status: `COMPLETE`  
Environment: `DEV` sub-account only  
Implementation: `tools/storage-spike`  
Machine-readable evidence: `artifacts/verification/stage-01-storage-qualification-large.json`

## Entry-state evidence

- Stage 0 is `COMPLETE` in `VERIFICATION_MATRIX.md`.
- The configured host and username are both the same dedicated Hetzner
  sub-account; the main account is rejected by configuration validation.
- The target is the DEV Storage Box root and contains only test data used by
  this qualification.
- SSH host identity is pinned with a SHA-256 fingerprint.
- The credential is kept outside source inputs, ignored by Git-compatible
  tooling and protected by a non-inherited Windows ACL.

## Qualification contract

The qualification uses Node.js `ssh2` over SFTP and must prove:

1. strict server-fingerprint verification and authentication;
2. StatFS quota visibility and capacity reserve;
3. directory create/stat and deterministic 20 GiB upload;
4. striped read-back with exact byte count and matching SHA-256;
5. bounded byte-range read;
6. write at a non-zero offset;
7. partial upload, disconnect, reconnect, resume and checksum;
8. rename;
9. eight simultaneous authenticated connections;
10. deletion of every test object and the generated namespace.

The large payload is generated in bounded chunks. No complete payload copy is
written to local disk or retained in process memory.

## Selected transport profile

| Concern | Selected value |
| --- | --- |
| SFTP library | `ssh2` 1.17.0 |
| Upload | one lane, 64 × 128 KiB outstanding writes |
| Upload logical buffer ceiling | 8 MiB per connection |
| Download | four lanes, 32 × 128 KiB outstanding reads per lane |
| Tested safe pool | eight connections |
| Host identity | mandatory configured SHA-256 fingerprint |
| Resume fallback | journaled temporary object and explicit offset |
| Commit model | size + SHA-256 verification, then rename |

## Exit-state evidence

The large report passed `npm run verify:large`. Its SHA-256 is
`5b4351c26fc78deb84c0e5a6529742cc4d1d42a96e02363e0717f0701b6495e2`.

| Exit criterion | Evidence |
| --- | --- |
| Machine-readable capabilities and measurements | 20 GiB report completed `2026-08-25T22:54:04.180Z`; 10/10 live checks passed |
| Round-trip SHA-256 | Exact 21,474,836,480-byte upload/read-back digest equality passed |
| Throughput | Upload 9.996 MiB/s; read-back 6.484 MiB/s |
| Bounded memory | Peak RSS 200.66 MiB; upload logical buffer 8 MiB; read logical buffer 16 MiB total |
| Segmented transport | 40 × 512 MiB read segments; zero retry attempts in accepted run |
| Reconnect and resume | Partial upload disconnect/reconnect/offset-resume and final checksum passed |
| Safe connection pool | Eight simultaneous authenticated connections passed |
| Storage capacity | StatFS reported 1 TiB available before the run |
| Remote cleanup | Report says complete and independent namespace listing returned `[]` |
| Credential absent from report | Structural secret-key validator passed |
| Local automated tests | 11/11 unit tests passed after the accepted run |

## Qualification incident and correction

The first 20 GiB attempt reached 100% upload and 80% read-back before three of
four striped SFTP lanes closed without completing their pending read callbacks.
The Node.js process remained alive at approximately 61 MiB RSS, proving that a
transport-level keepalive alone is not an adequate operation deadline.

The attempt was stopped without accepting its results. The one exact generated
namespace was discovered through a read-only listing, cleaned with the
non-recursive qualification cleanup command and a second listing returned an
empty set. No test object remained on DEV.

Corrective changes:

- every low-level SFTP read/write and wrapper call now fails closed on timeout;
- long read-back is split into 512 MiB segments;
- four transfer lanes are closed and recreated between segments;
- an incomplete segment hashes into a copied checkpoint and may be retried up
  to three times without committing partial hash state;
- cleanup/list tooling accepts only an exact
  `.vault-qualification-<uuid>` namespace and refuses recursive deletion;
- unit tests now cover a callback that never returns and an exact non-zero
  striped range;
- a 256 MiB live regression passed across four separately connected segments,
  with checksum equality, zero retries, complete cleanup and an empty final
  namespace listing.

The mandatory 20 GiB run was restarted from byte zero after these corrections.

## Rollback and cleanup

Each run creates one `.vault-qualification-<uuid>` namespace. Normal failures
enter a `finally` cleanup path, reconnect if necessary, unlink known files,
remove the namespace and confirm it no longer exists. Stage 1 is not complete
unless the report records `cleanup.complete: true`.

## Residual constraints carried into Stage 2

- Production must use a distinct sub-account and SSH key; this DEV password is
  not a production credential.
- The connection-pool ceiling starts at eight and is configurable downward.
- Stage 3 must add a per-operation deadline, bounded retry with exponential
  jitter, a semaphore and journaled state; the SFTP client does not provide
  those application guarantees by itself.
- Application code must use a provider-neutral adapter; importing `ssh2`
  outside the SFTP infrastructure package is forbidden.
- No upload becomes an authoritative visible resource before final size and
  digest verification.
