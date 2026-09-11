# Saturn branding contract

Status: `ACTIVE`

## Canonical name

The product and module name is **Saturn**. User-facing surfaces, operator
messages, documentation, release titles, WebDAV display names and source-level
product types use this name. The workspace package scope is `@saturn/*`, and
the root package is `saturn-gateway`.

Production releases use `saturn-vMAJOR.MINOR.PATCH` tags, `saturn-app` and
`saturn-web` OCI repositories, and `saturn-VERSION.zip` / `.sbom.json`
artifacts. The historical unscoped `v0.0.1` tag is not a production-release
identity.

## Compatibility identifiers

The following existing identifiers remain temporarily unchanged because they
are persisted, deployed, consumed by clients or form part of a security
boundary:

- `VAULT_*` deployment environment variables;
- `vault_*` and `__Host-vault_*` cookies;
- `X-Vault-*` HTTP headers;
- `vault.*.v1` serialized schemas and `vault-gateway` release-manifest role;
- `_vault_migrations` and existing SQL function names;
- current Docker project, service and volume identifiers, plus the `VAULT_*`
  runtime variables that carry immutable image references;
- existing `/opt/vault`, `/etc/vault` and `/var/lib/vault` deployment paths;
- the local source directory `C:\.projects\exocortex\saturn`.

These are legacy compatibility contracts, not the displayed product name.
Changing them requires an explicit versioned migration with dual-read or
dual-acceptance where applicable, deployment rollback instructions and updated
integration tests. New user-visible text must not introduce the old name.
