# Saturn UI/UX unification

## Authority

This implementation adopts `PART_I_INTERFACE_AND_INTERACTION_UNIFICATION.md`
and every PNG template linked from that document. The source specification in
the repository root is read-only and is not copied or modified here.

Where a reference image and prose differ, the prose is authoritative. Saturn
does not claim an external dependency is healthy when no validated connection
exists.

## Material-divergence decision — login view, 2026-09-02

The updated Part I section 4.1 and `example Log in page.png` place the service
brand above an exact `560x268px` authentication panel. The existing Saturn view
instead placed its icon, wordmark, reachability and explanatory copy inside a
generic padded panel, so the visible composition, hierarchy and control geometry
were materially different.

The operator explicitly requested adoption of the updated Part I login contract.
Saturn therefore uses its real planet asset in the `100x100px` brand box, keeps
the wordmark and icon outside the panel, and leaves only reachability, one empty
masked Access Key control and one submit action inside the panel. The change is
limited to web presentation and focus/error handling: owner-authentication API,
cookie sessions, rate limiting and storage boundaries are unchanged. Rollback is
a front-end revert. Acceptance requires component tests plus browser geometry,
responsive, keyboard, rejected-key, reduced-motion and console checks.

## Material-divergence decisions — existing sidebar

The operator subsequently selected the revised Part I boundary contract. The
desktop and revealed mobile sidebar therefore remain a `250px` border-box and
render one continuous `1px` level-one white line at the right edge. Content
still starts at `x=250`, so the boundary does not create a second seam or shift
the main track.

Adaptive sequential ordinals remain an independent open divergence: the current
Saturn menu keeps the previously selected reserved `03`. Preserving those stable
identities, adopting the revised Part I numbering, or staging a compatibility
migration remain viable and require a separate operator decision.

## Saturn Settings extension — 2026-09-03

Part I requires Appearance, Security, Backup, Updates and Logs and permits
additional service-specific sections. The operator explicitly selected
Telegram bot connection as Saturn's sixth full-width section. It is inserted
after Security, is independently reorderable, and is persisted as part of the
validated Settings order. Migration `0023_telegram_settings_section` inserts it
after Security without resetting the relative order of an existing five-card
preference.

Telegram is presentation-separated from Saturn's internal Drop-code issuer:
the card manages provider reachability and operator binding only. The bot may
activate the Gateway-owned Drop-code capability but does not own that
capability. Drop-buffer health remains an operational status under Security's
collapsed advanced controls.

## Input state

- Owner authentication already accepts one Access Key and stores only secure
  session cookies in the browser.
- The sidebar persists its fixed/auto-hide mode and a five-item order.
- Files, Drop Point, Shared, Trash and a legacy mixed Settings page exist.
- Structured audit events, the logical recovery engine and release metadata
  exist server-side, but the Settings information architecture is incomplete.
- No configured Kernel or privileged local updater is assumed.

## Normative target

- Fixed black/white/semantic palette with only `#00A8FF`-compatible accent
  customization, Space Grotesk display typography and Consolas UI typography.
- Exactly two visible outline levels: white outer boundaries and `#CCC` nested
  boundaries.
- Chronos interaction geometry: `#111` hover surface, accent boundary,
  proportional growth, uniform `.985` press and a non-transforming reduced
  motion mode.
- A 250 px reorderable desktop sidebar, a keyboard equivalent, template-stable
  two-digit ordinals (`03` remains reserved) and a modal mobile drawer at
  720 px and below.
- Universal reorderable cards with ordinal, four-dot handle, optional title
  divider and persisted order.
- Dashboard cards in CPU, RAM, Disk and Uptime logical order. Unknown or stale
  telemetry is named as unavailable and is never rendered as zero.
- Settings cards in Appearance, Security, Telegram bot, Backup, Updates and
  Logs logical order, with no page-level save action.
- Access Key only authentication. Credential fields always open empty and no
  credential is persisted in browser storage.
- Kernel reads expose only non-secret URL, public identity, reachability and
  revision. Token replacement is write-only and may activate only after remote
  validation; an unconfigured Kernel remains explicitly unavailable.
- Update discovery remains unavailable until a real least-privilege updater and
  approved registry are configured; the UI never simulates an update.

## Implementation stages and state transitions

### U1 — Foundation

Input: legacy mixed tokens and inconsistent component geometry.

Output: normative tokens, typography, two outline levels, common controls,
Chronos pointer/keyboard states, reduced-motion behavior, adaptive shell and
accessible overlays.

Verification: lint, web unit tests, typecheck and desktop/mobile visual checks.

### U2 — Navigation, cards and dashboard

Input: five persisted destinations and no dashboard/card order.

Output: Dashboard becomes the first primary destination; navigation, dashboard
cards and Settings cards persist validated unique orders. Dashboard and
Settings card ordinals recompute after moves; sidebar ordinals retain the
stable identities shown in the Saturn menu template.

Verification: migration pair, repository validation, keyboard reorder tests and
responsive browser checks.

### U3 — Settings information architecture

Input: Appearance mixed with Telegram, WebDAV, producer and session controls.

Output: six full-width universal cards. Appearance changes only accent;
sidebar mode commits immediately. Telegram connection is a separate Saturn
section. Existing auxiliary access management remains inside Security without
displacing the five universal sections.

Verification: immediate preview/revert/apply tests and honest unavailable-state
tests for optional dependencies.

### U4 — Narrow credential contracts

Input: immutable bootstrap Access Key and no browser-safe Kernel configuration
workflow.

Output: a salted server-side Access Key verifier can be replaced atomically
after current proof and matching replacement entries; other sessions are
revoked. Kernel URL/token operations are separate, CSRF-protected, recently
reauthenticated and never return token material.

Verification: credential rotation, rollback-on-validation-failure, session
revocation, response redaction and audit tests.

### U5 — Operational surfaces

Input: audit and recovery/update capabilities not consistently exposed in the
owner UI.

Output: bounded polling log stream with cursor deduplication and same-origin
export; backup and update controls reflect only executable server capability.

Verification: bounded DOM/pagination tests, no-store download checks and
unconfigured dependency states.

## Deliberate capability boundaries

- A missing Kernel credential is `not configured`, not an error-colored fake
  success.
- A missing local updater is `unavailable`; discovery and installation remain
  disabled with an explanation.
- Destructive restore is not enabled unless the server can validate the entire
  uploaded archive, create a pre-restore snapshot, establish its write barrier,
  roll back and report post-restore health in one persisted workflow.
- Disk capacity stays `unavailable` when the selected storage adapter cannot
  supply reliable total/free values.

## Completion state

The change is complete only when quality gates pass, the browser shows the same
hierarchy and interaction rules at desktop and mobile widths, no secret reaches
URL/storage/log/response output, and every unavailable operation is explicit
rather than simulated.

## Verification result — 2026-09-02

- `pnpm verify` passes: lint, monorepo typecheck, all tests and all production
  builds.
- The live local login view was checked at `1919x1034`, 390 px and 320 px. At
  reference width the panel is `560x268px` at `y=444`, reachability is
  `255x50px` at `y=466`, the field is `511x31px` at `y=578.5` and the button is
  `511x50px` at `y=635`; the half-pixel horizontal centering on the 1919 px
  export rasterizes to the documented coordinate. No viewport has horizontal
  overflow and the browser console has no warning or error.
- Invalid Access Key handling remains on the fixed-size login surface, clears
  the submitted value, preserves reachable health and returns focus to the
  Access Key field without leaking the credential into URL or browser storage.
- Universal-card pointer drag starts only from the four-dot handle; the complete
  card remains the drop target. `Alt+ArrowUp` and `Alt+ArrowDown` remain the
  keyboard equivalent.
- Migration `0017_ui_unification` was applied to the local development database.
- Kernel and updater actions remain visibly unavailable until their real
  deployment dependencies are configured; no simulated success path was added.
- Web recovery now exposes the verified Stage 5 engine through the owner-only
  persisted workflow documented in `WEB_RECOVERY_WORKFLOW.md`: fresh snapshot
  download, bounded upload, full pre-mutation validation, verified pre-restore
  snapshot, exclusive write barrier, transactional replace, rollback and
  post-restore checks.

## Settings refit verification — 2026-09-03

- The Settings route renders six independently reorderable full-width cards:
  Appearance, Security, Telegram bot connection, Backup, Updates and Logs.
- At the local desktop viewport, the page title starts at `(280, 15)` and the
  Appearance card at `(280, 153)` with a `401px` height. Its color controls
  start at `x=322/382/728/871` and measure `40/326/123/123px`, matching the
  Part I ledger.
- The Access Key overlay opens with all three credential fields empty. Kernel
  token material and Telegram provider credentials are never rendered.
- The log viewport is bounded at `460px`; its header is `36px`, data rows use
  the normative `25px` cadence and outcome text accompanies semantic color.
- Migration `0023_telegram_settings_section` passed a real DEV down/up cycle
  and preserves the relative order of the five pre-existing cards.
- `pnpm verify` passes: lint, monorepo typecheck, 114 tests and all production
  builds.
