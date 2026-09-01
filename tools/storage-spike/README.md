# DEV Storage Box qualification tool

This package qualifies the Storage Box transport before any Saturn runtime code
depends on it. It is intentionally isolated from the future Gateway packages.

## Safety contract

- only a DEV sub-account is accepted;
- the configured SSH host key fingerprint is mandatory and is compared with a
  timing-safe SHA-256 check;
- the password is read from a caller-supplied file and is never added to the
  report;
- every run operates below a random `.vault-qualification-<uuid>` namespace;
- the namespace is removed in `finally`, including failed runs where the SFTP
  connection can be re-established;
- generated payloads and checksum calculation are bounded-memory operations;
- a StatFS guard refuses a run that would consume the available capacity or its
  512 MiB safety reserve.

## Commands

Run the local unit suite:

```powershell
npm test
```

Run the fast 64 MiB live contract suite:

```powershell
$env:VAULT_STORAGE_CONFIG = (Resolve-Path '.\storage.dev.json')
$env:VAULT_STORAGE_PASSWORD_FILE = '<protected password file>'
$env:VAULT_STORAGE_REPORT = '<report path>'
npm run qualify
```

Use `storage.dev.large.json` for the mandatory 20 GiB qualification. Reports
contain the public endpoint, expected fingerprint, capabilities, timings,
bounded-memory metrics and cleanup status, but no credential or credential-file
path.

## Covered behavior

1. SSH/SFTP authentication with strict host identity verification.
2. Storage capacity and quota visibility through OpenSSH StatFS.
3. Namespace create and stat.
4. Deterministic pipelined upload and remote-size verification.
5. Multi-connection striped download and round-trip SHA-256 verification.
6. HTTP-Range-equivalent byte-range read.
7. In-place write at a specific offset.
8. Interrupted upload, disconnect, reconnect, append and final checksum.
9. Atomic rename behavior exposed by SFTP.
10. Eight simultaneous authenticated connections.
11. Remote cleanup confirmation.

## Selected transport profile

- Node.js `ssh2` SFTP client;
- one upload lane with 64 outstanding 128 KiB writes (8 MiB maximum logical
  buffering for the connection);
- four download lanes with 32 outstanding 128 KiB reads per lane, rotated after
  each 512 MiB segment for long read-back operations;
- 60-second fail-closed deadline for every SFTP callback;
- eight connections as the tested safe pool ceiling until production telemetry
  justifies a different limit.

The application-level fallback for interrupted uploads is a journaled temporary
object plus explicit offset resume. A transfer is not made visible until its
size and SHA-256 digest are verified and the temporary object is renamed during
the Gateway commit step.
