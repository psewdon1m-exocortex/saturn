# Saturn dashboard and transfer tasks

## Authority and scope

This stage implements the dashboard contract from
`PART_I_INTERFACE_AND_INTERACTION_UNIFICATION.md` and the Saturn-specific
reference `saturn/.src/saturn dashboard.png`. The root specification and its
assets remain read-only.

The operator additionally requires one real `4x2` task card. At the canonical
desktop width this means the full `1610px` dashboard track and two `166px` base
rows separated by the standard `30px` row gap: a `362px` minimum height.

## Material-divergence decision — operational transfer telemetry, 2026-09-02

The input dashboard exposes only four process metrics and polls every fifteen
seconds. The reference also contains Storage, Drop Point and reachability
positions, while the requested task surface has no server contract at all.
Rendering invented jobs, zero throughput or fictional Storage Box capacity
would violate the normative unavailable-state rule.

Saturn therefore extends the protected operator overview with bounded,
read-only operational telemetry:

- owner, Drop Point and device-sync uploads come from persisted
  `upload_sessions` rows, while producer backups come from persisted
  `service_backup_runs` rows;
- upload throughput is calculated from received-byte deltas between real
  samples;
- downloads are measured by a singleton API monitor wrapped around the real
  owner, public-share, WebDAV and Laboratory response streams;
- aggregate upload/download flow is the sum of measured current task rates;
- `created` uploads are queued, `failed_retryable` uploads are waiting for a
  retry, and active upload lifecycle states remain named;
- indexed storage bytes come from active file metadata, while physical
  capacity remains explicitly unavailable because the SFTP adapter does not
  expose trustworthy total/free values;
- Gateway reachability uses the existing readiness probe; no synthetic success
  state is introduced.

The monitor contains no credential or storage path and retains completed or
failed download summaries only briefly so a polling UI can observe the terminal
state. It is local to the API process: a future multi-instance deployment must
replace or aggregate it through shared telemetry before claiming fleet-wide
download flow.

## D1 — Contract and data sources

**Input state**

- protected `GET /operator/overview` returns CPU, RAM, Disk and Uptime only;
- no download-flow observer exists;
- active uploads already persist byte progress and lifecycle state;
- owner preferences persist only the four original dashboard card IDs.

**Output state**

- the overview returns logical CPU cores, indexed storage usage and a bounded
  transfer snapshot;
- owner and public-share download streams feed the monitor without buffering
  file bodies;
- dashboard preferences validate and persist all eight card IDs;
- migration `0018_dashboard_transfer_tasks` upgrades existing preference rows
  and the database default.

**Verification**

- monitor unit tests cover streaming bytes, terminal state, throughput and
  upload queue classification;
- API and web typechecks prove the shared response shape and injection wiring.

## D2 — Reference dashboard layout

**Input state**

- metric cards reserve a generic titled header and use oversized display type;
- the dashboard uses a `20px` gap and a two-column grid only;
- title casing and content geometry do not match the reference.

**Output state**

- the page title is `dashboard` and the content begins after the exact `123px`
  page header with a `30px` inset;
- CPU/RAM and Disk/Uptime use exact `2x` tracks, Storage uses `4x`, Drop Point
  and reachability use `1x`, and Tasks uses `4x2`;
- the canonical grid is derived from four `375px` content tracks separated by
  `40px`, `30px`, and `40px`, producing exact `790px` and `1610px` spans;
- untitled metric cards keep the documented ordinal, title, value and attached
  `9px` progress geometry without an empty header;
- all cards remain reorderable, ordinals adapt, persisted order survives login,
  and the packing algorithm preserves exact supported spans;
- narrow layouts collapse to one readable column without changing DOM,
  keyboard or persisted logical order.

**Verification**

- component tests verify all real states, card names and persisted order;
- production build and full monorepo quality gates pass;
- browser checks cover the `1919x1034` reference viewport, responsive collapse,
  no horizontal overflow, accessibility names and console errors.

## Completion state

The stage is complete when task rows and rates are derived only from measured
Gateway activity, empty/unknown states are named, no file bytes are buffered by
telemetry, the reference desktop geometry is within the documented one-device-
pixel tolerance, and all tests and builds pass.

## Verification result — 2026-09-02

- Migration `0018_dashboard_transfer_tasks` was applied to the local DEV
  database; the migration manifest test includes its up/down pair.
- `pnpm verify` passes: lint, all 19 workspace typechecks, all tests (including
  10 web tests and 7 API tests), and every production build.
- Streaming tests prove measured bytes reach the consumer unchanged, terminal
  state is observable only for the bounded retention window, and persisted
  uploads report queue position and byte-delta throughput.
- At the `1919x1034px` browser fixture, card origins are exactly
  `y=151/347/543/739/935`; single-row cards are `166px` high and Tasks is
  `362px`. Rasterized widths are `789.5px`, `1609px` and `374.75px` for the
  normative `790px`, `1610px` and `375px` tracks on the one-column-short PNG
  export.
- At `390px` and `320px`, all eight cards collapse into one logical column,
  Tasks remains readable, the mobile menu is exposed and the document has no
  horizontal overflow.
- The local API and readiness probe remained healthy after hot reload. Visual
  verification used a removed deterministic fixture and did not use, expose or
  persist the Owner Access Key.
