# Saturn embedded operator guide

Updated: 2026-10-11. The authenticated **Documentation** destination at
`/documentation` replaces the former five summary cards with an 18-topic guide.
It adopts central Part 01 sections 5.6, 5.7 and 10.7 and the Part 06 acceptance
contract. Kernel's Documentation view is the composition reference; Saturn's
operator instructions are verified against Saturn, Neptune, Pluto and host
recovery workflows rather than copied from Kernel.

## Content ownership and current workflows

`apps/web/src/documentation-sections.tsx` owns stable article IDs, order, groups,
titles, summaries, rendered bodies, additional keywords and the guide revision.
The rendered text itself enters the local search index. Keywords supplement it;
they cannot hide an operator term absent from the article. The revision identifies
the guide content, not the installed service or agent version.

| Group | Current topics |
| --- | --- |
| Get Started | Introduction; Access and prerequisites; Workspace and first upload |
| Operate | Storage and Storage new; Uploads and interruptions; Downloads and Quick Preview; Archives and task status; Versions and Trash; Shared links; Drop Point and Gryphon; Synchronization and service backups; Host services recovery; Neptune Windows; Pluto outdoor backups |
| Maintain | Storage connection and catalog; Saturn backup and restore; Updates and compatibility; Diagnostics and recovery checks |

The guide now distinguishes a multi-client Drop admission code from a one-time
agent enrollment code. Host recovery lists **Updater, Neptune, Gryphon, Wyvern
and Window**, with separate code, credential, encryption-key and archive
lifecycles. Normal host discovery uses Kernel Register; an explicit Saturn
origin override is a diagnosed fallback. Pluto's guide describes Linux-only
installation, Outdoor service tokens, the separate copying switch, source
permissions, direct hierarchy, 256 MiB file limit, ten-version retention,
regular-file symlink behavior and completed database dumps. Windows describes
one-way copying and independent scoped profiles.

Recovery instructions explicitly distinguish the Saturn control-plane ZIP from
stored file bytes and secret recovery material, and explain the maintenance
guard, isolated restore drills, paired release health and failed rollback.
Heartbeat, transfer progress, server response completion and a verified restore
are never presented as interchangeable evidence.

## Layout and interaction

`documentation-page.tsx` owns the view and `documentation.css` scopes its styles.
The existing owner authentication, global navigation and Quick upload remain.
`app.tsx` gives the active view a bounded content class; the production static
server permits `/documentation` with the same private/no-store, noindex and CSP
headers as other owner routes. Refresh and direct navigation still pass through
the normal owner login gate.

Desktop height derives from Saturn's 123 px shared header and 28/40 px content
padding, with consecutive `100vh` and `100dvh` declarations. Navigation is
220 px wide, the gap is 30 px and the article is capped at 1120 px. At 1000 px
and below the two owners stack; at 720 px and below the calculation follows
Saturn's existing 112 px narrow header and 20/20 px padding. Short viewports
reduce the navigation-row minimum rather than introducing page scrolling.

The complete navigation (including search) and complete article are the only
two vertical scroll owners. Both retain native input, accessible names, tab
entry and focus outlines while hiding visual scrollbars and containing
overscroll. Tables can scroll horizontally inside the article. No global
`body` overflow lock or wheel/touch cancellation is introduced.

Search trims only its searchable copy and uses stable `en-US` case folding and
substring matching over group/title/summary/keywords/rendered body. The displayed
query is preserved; it is not persisted in a URL or browser storage. The clear
cross occupies a permanent 32 px track, hides/disables when empty and returns
focus to the input on the next animation frame. Escape uses the same path.
The visible placeholder is **Search**, which fits the canonical 220 px control
without clipping; the accessible input name remains **Search documentation**.
The page heading is lowercase **documentation**, as requested by the operator.
Filtering resets only the article before rendering and clamps navigation.
No matches keep both tracks and a labelled empty result.

Section buttons expose `aria-controls`. Activation scrolls only the article to
a 30 px inner reading offset. Reduced motion jumps immediately. Article scroll
and resize synchronize exactly one current destination without moving the
navigation or stealing focus, including the final article at maximum scroll.
Reopening the view resets query and both offsets; fragment history is not used.

## Verification and ongoing documentation gate

Run the normal repository gate and the built-bundle browser acceptance:

```sh
pnpm verify
node --test infra/production/static-server.test.mjs infra/production/nginx-ingress.test.mjs
pnpm verify:documentation
```

The component suite covers all article/target relationships, current UI terms
in real copy, body search, normalization, empty groups/results, clear/Escape,
focus, article-relative activation and current-section state. The browser
runner uses the production static server on an ephemeral loopback port and
synthetic authenticated API responses. It creates no backend objects and closes
its browser and server on completion.

The 19 browser checks cover 320–1920 px, 320/420 px short viewports, fixed and
auto-hide sidebar, two-owner geometry, wheel/boundary and keyboard input,
30 px navigation offsets, search geometry, table overflow, resize/reset,
normal/reduced motion, owner authentication, private route headers and automated WCAG A/AA checks. Screenshots and a JSON
receipt are written into the audit output directory. Chromium fixtures do not
qualify real touch hardware, mobile virtual keyboards, SFTP transfers, database
restore or production availability.

Every outgoing operator-visible change must update its affected embedded topic
and technical runbook in the same revision, then pass the central documentation
impact gate. Review prerequisites, defaults, consequences, failure/recovery
paths, current labels and discoverability. Do not put example secrets, private
repository addresses or secret-bearing links in the guide or its search index.

Rollback reverts these web/static-route/documentation changes. No database
migration, stored-file mutation, token change or producer-policy change is
needed.
