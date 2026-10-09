# saturn deployment and recovery contract

This service-local record is subordinate to the coordinated
[Part 11 deployment profile](https://github.com/psewdon1m-exocortex/general/blob/main/PART_11_INITIAL_MULTI_SERVICE_DEPLOYMENT.md)
and the shared-agent contracts in
[Part 09](https://github.com/psewdon1m-exocortex/general/blob/main/PART_09_SERVICE_AGENTS_DEPLOYMENT_AND_LIFECYCLE.md) and
[Part 10](https://github.com/psewdon1m-exocortex/general/blob/main/PART_10_SERVICE_AGENTS_UI_AND_OPERATOR_WORKFLOWS.md).

Saturn 0.2.7 pins the published Updater 0.6.13 and Neptune 0.1.13 host
artifacts. Its release qualification records the exact published Kernel 0.3.10
machine-principal migration, resolution and revocation contract for INT-16.

Owner login and administration routes use the public/non-indexable authenticated profile and are reachable from every client IP. Access Key verification, sessions, CSRF and reauthentication protect owner data. Public capability, backup enrollment/ingest, WebDAV and Neptune check-in routes retain their own authentication. Configure explicit trusted proxies; do not trust arbitrary forwarded IP headers. The server-managed Nginx denies probes before proxy routing and serves `/synchronization` for authorized operators while health stays host-local. Saturn owns no public listener or TLS state: its API and static web process bind only to host loopback. Recovery validates archived public settings and SFTP access before database replacement, restores the active storage profile, and rolls back both configuration and PostgreSQL on failure. Updater installs matched app/web images, runs migrations and holds the operator-downloaded database snapshot in RAM for rollback; after restart, the original ZIP must be uploaded. See [protocol 2 migration](docs/UPDATE-PROTOCOL.md).

## Trust and operator prerequisites

The selected deployment profile contains Kernel, Volt, Saturn, Updater, Neptune and Gryphon. Per-host agents are reused when healthy; attaching a service does not silently downgrade or reinstall them. Root `sudo updater tui` owns shared-agent release checks and updates. Each service's Settings owns its own Neptune policy and scoped agent bindings. Jobs retain their identifiers across page reloads and must reach a verified terminal result.

Release manifests use detached RSA-PSS-SHA256 signatures with a per-project RSA key of at least 3072 bits, while Saturn retains its Ed25519 installer signature. Keep both private keys only in GitHub Secrets and expose them only to the protected release-signing job. CI derives the public counterparts and embeds them in Saturn's versioned `bootstrap.sh`; bootstrap creates `/etc/exocortex/release-trust/saturn.pem` and `/etc/vault/release-public-key.pem`, verifies the manifest before downloading the service, and never replaces an existing mismatching key automatically. No `scp`, manual release-key fingerprint or separately downloaded public key is part of this trust path. Saturn releases using server-owned Nginx require Updater 0.4.9 or newer.

Populate actual Kernel/Volt bootstrap coordinates, service tokens, SFTP host fingerprint, canonical HTTPS origins and exact server-Nginx proxy hops. Saturn has its own bootstrap and mode-`0600` `/etc/vault/.env.production`; neither is shared with another service. Its login is public-authenticated and reachable from every client IP: do not introduce `OPERATOR_CIDR`, a VPN prerequisite or an IP allow-list. Access Key validation and bounded application sessions protect all owner data. Saturn runs no embedded Nginx and uses no coturn; a genuine future WebRTC NAT-traversal feature requires a separate reviewed TURN decision. Secrets must not appear in links, responses, browser persistence or logs. Public login pages remain non-indexable; crawler directives are not an authentication boundary. Resolve service data and generated link origins through Kernel; bootstrap trust and local loopback helper endpoints are explicit exceptions.

## Recovery boundaries

Keep the Access Key and host-recovery passphrase separately from recovery files. Main-service recovery retains user settings and application data while preserving or requiring re-enrollment of external host trust. Host recovery is controlled through `sudo updater tui`: Updater, Neptune, Gryphon and Wyvern are optional independent pipelines with separate setup codes, producer identities and revoke lifecycles. Gateway stores each configured service under its own `backups/<service>/<server>` tree; an absent service needs no identity. Saturn exposes neither a helper-recovery browser form nor a proxy route. The files exclude executables, release trust keys, systemd units and head deployment environments. Install trusted software before restoring one downloaded service-scoped file. Each file fails explicitly at 128 MiB expanded or 10000 files; it never silently omits data or replaces neighboring service roots.

## Acceptance evidence

The seven-area policy in .github/pre-push-gate.json is required after native CI verification. Public indexing is intentionally not applicable. For an uncommitted local review run the gate with --worktree after the native checks. Gate PASS checks policy/evidence/verification linkage; it is not a substitute for executing the integration scenarios.

Qualify the connected system with real HTTP Kernel→Volt authentication, clean archives/restores, PostgreSQL and pinned SFTP, independent Volt mirror, Windows folder synchronization, network interruption/replay, signed artifact rejection, unauthenticated-edge negative cases and helper installation/reuse. Record PASS, FAIL and NOT_RUN separately. Production credentials, signed publication and actual deployment remain operator provisioning operations.

See [README](README.md) for service commands.
