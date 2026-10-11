# Storage new: optional owner interface

On 2026-10-11 the operator explicitly requested a second Storage tab based on
the current public shared-link design described in Part 01 section 11, while
preserving the original Storage design and functionality. This authorization
applies only to **Storage new**, for the authenticated owner. It does not change
the rest of Saturn or other services.

`/files` keeps the original table. `/storage-new` shows the same resource tree
as a card grid. Nested URLs use encoded folder names and keep the new route
through breadcrumbs and browser history. Neither presentation has its own
storage or permission model: both use `FilesView`'s existing handlers, owner
session, CSRF protection and backend resource policies.

The original information sequence is service title → path/count → search →
table. The optional sequence is current folder title/actions → complete path
and count → search/sort → file cards. Modification time, size and sharing status
remain visible. Full names wrap rather than relying on hover-only tooltips.
Cards have no checkboxes or ellipsis buttons, and selection does not insert an
action toolbar. Select names/card metadata with a click, Ctrl/Cmd for multiple
items or Shift for a range; selected cards remain outlined and the count remains
visible. Right-click a card for its actions or the grid background for folder
actions. Shift+F10/the context-menu key opens the same menu from keyboard focus;
Escape closes it and restores focus. The bounded menu scrolls on short screens.
Open/preview, versions, overwrite, move and copy-to-folder are available there
alongside clipboard, sharing, archive and confirmed trash actions. Group
selection remains available for ZIP and trash; protected roots still block
destructive operations. Existing handlers, dialogs and quick preview are reused.
Root uploads remain blocked; protected roots cannot be moved or trashed.

## Private visual contract

The `.storage-new` root scopes the authorized departures from the standard:
warm light background `#f3f1eb`, panels `#fffef9`, ink `#171714`, muted type tints,
Space Grotesk body/control text, compact Consolas metadata, and subtle card
shadows. Configurable accent is blended with dark ink for the light surface.
The blend uses 36% accent and 64% ink to keep small accent text readable even
with a pale yellow or white configured accent. Controls have at least 40 px
targets, main actions 46 px. Cards reserve 148 px
visual areas (132 px on small screens), with a 230 px minimum desktop track and
16 px gaps. At 720 px and below, actions/search stack and cards become one
column; content scrolls in normal page flow. Keyboard focus and reduced-motion
styles are explicit. The operator also requested a light shared-access dialog
for the card's Shared action. It shows the object name, copyable URL and access,
expiry, password and current status in a bounded 640 px panel. Copy uses the
existing capability endpoint (including legacy link replacement), exposes the
URL for manual copying, and blocks duplicate clicks while copying. Revoke uses
the existing immediate revocation handler and preserves stored files. Escape,
focus trapping/return, header dragging and internal scrolling reuse the common
dialog behavior. New folder uses the same light control treatment in a bounded
560 px dialog, with the complete destination path, a labeled name field and a
Create folder action. Both the top action and the context-menu action use the
existing folder-creation handler for the resolved current folder. The original
Storage dialogs and other dialogs/previews retain the common dark operator
contract.

Breadcrumb hover underlines the folder label without changing its background or
text color. Path separators remain undecorated; keyboard focus keeps its outline.
Name, Modified and Size likewise use underline on hover/focus without a filled
background. The current sort remains identified by its arrow and darker label.
On desktop the search field's lower edge aligns with the breadcrumb divider;
the item count stays below it. At 720 px and below search follows the path/count
on its own full-width row.
Back and Forward arrows beside the path traverse known adjacent Storage new
entries in the current browser session using browser history; they do not leave
the tab for another Saturn section. Opening a folder after Back discards the
forward branch. Up one level opens the parent path and is disabled at root.
Unavailable directions and navigation while loading or mutating are disabled.
After a reload the known history starts at the current path; Up remains available
for a directly opened nested URL. Controls have 40 px targets, accessible names,
keyboard focus and thin inline SVG arrows in the private light palette.

In auto-hide sidebar mode the workspace extends to the left viewport edge.
The 18 px navigation activation area is a transparent overlay, so it neither
reserves content width nor paints a dark strip on this light presentation.
Pointer, keyboard and mobile menu entry remain available.

Image cards lazily request the **existing authenticated owner preview** endpoint
and fall back to a type icon. Other types show icons and open the existing quick
preview on request where supported. This change adds no public thumbnail URL,
media processor, external CDN, capability or unauthenticated access.

## Preferences and compatibility

An old seven-item saved navigation order receives `storage-new` immediately
after `files`; existing item order and other preferences are preserved. An
eight-item order can place the new tab anywhere. API preference validation
accepts the old complete list and the new complete list, rejects duplicates or
missing destinations, and normalizes old writes. No database schema migration
or file migration is required. Upgrade the API and web together because the old
API cannot save an eight-item navigation list. No version/release is created
by the preference migration itself. The interface and its API compatibility
change are released together in `saturn-v0.2.11`.

Both interfaces remain available until the operator explicitly decides their
future. Removal is not automatic and belongs to the operator.

## Verification

`pnpm verify` runs lint, all builds, type checks and the default tests.
`storage-new.test.tsx` checks routing, old navigation compatibility, preservation
of the original collection, right-click/keyboard menus, selection/search, archive submission, file chooser
and drag/drop dispatch, root restrictions, trash confirmation and failed-path
retry, group trash/clipboard paste and the right-clicked file's version/overwrite
identity. `auth.controller.test.ts` checks both preference generations.

For reproducible visual/browser acceptance, build the web app, then run
`node scripts/verify-storage-new.mjs` from the Saturn repository. By default the
runner starts the production static server on an ephemeral loopback port and
closes it on completion. It intercepts all API calls with synthetic data, exercises
the real frontend upload protocol and browser download, and stores screenshots
and `result.json`. Override `SATURN_UI_ORIGIN` and `SATURN_UI_OUTPUT` as needed;
the origin must be localhost. It checks root/nested views at 320, 375, 720, 768,
1024, 1440 and 1920 px, one/empty/120 items, long names, missing images, request
errors/retry, multiple accents/contrast and switching back to the original table.
The static-server tests verify the new root/nested routes and noindex headers.

Browser fixtures do not establish live backend persistence, production access
or load endurance. The default backend checks are separate; environment-gated
integration tests remain gated. Production and user files are untouched.
