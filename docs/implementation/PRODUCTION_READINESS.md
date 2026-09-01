# Production readiness and activation gate

Status: `BLOCKED` on external production inputs  
Implementation result: `READY_FOR_PRODUCTION_ACTIVATION`

## What is complete locally

The complete Saturn Gateway implementation is built and verified in an isolated
production-like environment. The accepted Stage 13 report is
`artifacts/verification/stage-13-production-hardening.json`. Its final digest
is computed independently after the last source-frozen run.

The aggregate gate covers:

- frozen install, lint, type checking, 83 tests and release build;
- non-root read-only API/worker/edge images without source maps or secret files;
- HTTPS-only, key-only, file-secret and immutable-image production policy;
- edge-only publication with internal API, worker and PostgreSQL networks;
- tag-only pinned CI/release workflows, OCI SBOM/provenance and an Ed25519-signed
  canonical release manifest;
- migration, canonical 21-directory bootstrap and exact temporary-object cleanup;
- HTTPS owner login, upload, metadata, Range, checksum and trash workflow;
- SFTP and PostgreSQL outage/recovery plus fail-closed candidate rejection before
  traffic switch;
- clean PostgreSQL dump/restore comparison and provider-exit byte/SHA comparison;
- final runtime log, release artifact and container-image secret scans.

No real PROD Storage Box access or user data was used by this gate.

## External inputs required to unblock production

| Input | Required invariant | Evidence required before use |
| --- | --- | --- |
| PROD Storage Box sub-account | Not the DEV username; access restricted to the PROD directory | Username, verified host fingerprint and empty namespace check |
| PROD SSH key | Dedicated key-only identity; main account remains offline break-glass | Private key file mode `0600`, successful pinned-host validation and rotation owner |
| Canonical domain | HTTPS public origin controlled by the operator | DNS result, ACME contact and valid external TLS chain |
| Production host | Supported Docker/Compose host with only edge ports public | Host inventory, firewall result and unauthorized-vantage port scan |
| Production secret set | Nine distinct generated secret files, never copied from DEV | File ownership/mode validation and rotation record |
| Independent second copy | Physically or administratively independent of the primary Storage Box | Destination identity, freshness check and restore evidence |
| RPO/RTO | Explicit operator-approved numeric targets | Values in production policy and measured recovery result |
| Laboratory publication | Explicit `private` or approved public non-indexable decision | Recorded owner decision and route/cache test |
| Release trust | Registry, tag policy, signing secret and independently trusted public key | Protected release environment and public-key fingerprint handoff |
| External test vantage | Network not sharing the production host/private network | 80/443-only result and denial of DB/API/worker/SFTP transports |

DEV credentials are not substitutes for any item in this table.

## Activation sequence

1. Provision the dedicated PROD sub-account, host, DNS, second copy and secrets.
2. Fill only operator inputs in `.env.production`; run `pnpm prod:validate`.
3. Push a protected semantic version tag. The release workflow builds candidate
   images once, tests those digests, signs the bundle and publishes only on pass.
4. Install the independently trusted release public key on the clean host and
   run the pinned `bootstrap.sh` with the HTTPS manifest URL.
5. Run `vaultctl validate`, `vaultctl install`, `vaultctl bootstrap-storage` and
   `vaultctl smoke`. Confirm the generated smoke object was deleted.
6. From the independent vantage, verify TLS, approved routes and that no internal
   listener is reachable.
7. Exercise second-copy delivery and an isolated restore within the approved
   RPO/RTO. Keep the prior digest and verified database snapshot.
8. Load real data only after all preceding evidence is attached to the release.

Stage 13 moves from `BLOCKED` to `READY` when the external inputs exist, and to
`COMPLETE` only after this sequence succeeds against the real PROD environment.

## Rollback boundary

Before traffic switch, any failed gate discards the candidate and leaves the
current release untouched. After switch, restore the previous immutable image
references; use migration rollback only when declared compatible, otherwise
restore the verified pre-update database snapshot. Never reconnect PROD to DEV
or to the break-glass main account as an emergency shortcut.
