# Saturn branding contract

This document specializes [Part 01 — interface and interaction unification](https://github.com/psewdon1m-exocortex/general/blob/main/PART_01_INTERFACE_AND_INTERACTION_UNIFICATION.md); that central contract remains authoritative.

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

## Current artwork — operator request, 2026-10-11

The operator selected [Saturn devouring his son](../../.src/saturn-devouring-his-son.png)
as Saturn's logo and icon source. Every export preserves the complete square
image, its proportions and colors. The former beige planet remains a historical
reference, rather than the current product artwork. This replacement is specific
to Saturn and does not authorize brand changes in other services.

Generate the assets from the repository root with
`node scripts/generate-brand-assets.mjs` after installing the locked workspace
dependencies. The script uses the existing Sharp dependency and produces:

- `apps/web/src/assets/saturn-logo.png`, a 512 × 512 PNG imported by the login,
  owner sidebar and public-share header; Vite gives its production URL a content
  hash;
- PNG icons at 16, 32, 48, 64, 128, 180, 192, 256 and 512 px in
  `apps/web/public/assets/`, each with a content hash in its filename;
- an ICO with 16, 32, 48, 64, 128 and 256 px frames in the same public assets
  directory;
- a 32 px `apps/web/public/saturn-favicon.png` for the existing compatibility
  URL.

The generator also updates the favicon and 180 px Apple touch icon links in
`apps/web/index.html`. Hashed icons live under `/assets/`, which the existing
production static server serves with immutable caching. Changing the artwork
therefore changes the URLs selected by the next build.

The login keeps its 100 px brand box (76 px on narrow screens). The sidebar
shows the full image in a 192 px square and places the wordmark below it without
overlap. The public-share header keeps its 42 px icon (36 px on narrow screens).
The password-entry share screen retains its existing text-only wordmark.

Verification on 2026-10-11: web production build and type checking, all 73 web
tests, targeted web lint and the production static-server test passed. Isolated
Chromium checks against the built production server verified the login, sidebar
and public-share header at 1440, 390 and 320 px: images loaded at their intended
dimensions, the sidebar wordmark did not overlap the artwork, and the pages had
no horizontal overflow or uncaught browser errors. All exported icon files and
the compatibility favicon returned the correct MIME type; the ICO contained all
six expected sizes. The original artwork's bytes were preserved.

### Login image loading regression — 2026-10-11

The previous login used `/saturn-planet-on-black.png`. The production static
server's explicit route list refused that root-level path even when the PNG
existed in its filesystem. A fresh anonymous browser reproduced the issue at
`https://exocortex-saturn.shmoza.net/synchronization`: the image request returned
404 and its decoded dimensions were zero. The deployed frontend still used the
previous asset URL at the time of this check.

The current Vite-imported logo is served under `/assets/`, an existing public
route on both Nginx and the static server. Local production-browser checks
confirmed HTTP 200, `image/png`, successful image decoding and correct geometry
at 1440, 390 and 320 px on cold load, reload and an unauthenticated nested owner
route. Deploying this web build is required to update the server's login page.
The Stage 13 production browser check now requires the login image to decode
successfully, so a visible Access Key field alone cannot pass that entry check.

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
- existing `/opt/vault`, `/etc/vault` and `/var/lib/vault` deployment paths.

These are legacy compatibility contracts, not the displayed product name.
Changing them requires an explicit versioned migration with dual-read or
dual-acceptance where applicable, deployment rollback instructions and updated
integration tests. New user-visible text must not introduce the old name.
