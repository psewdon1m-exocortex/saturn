# Saturn sidebar UI/UX implementation

Status: `COMPLETE`.

Normative inputs:

- `C:\.projects\exocortex\.docs\UNIFICATION_SPECIFICATION.md`;
- `C:\.projects\exocortex\.docs\PART_I_INTERFACE_AND_INTERACTION_UNIFICATION.md`;
- `C:\.projects\exocortex\.docs\src\example Left Menu.png`;
- `C:\.projects\exocortex\.docs\src\Example of left menu and main page side by side, base layer of main page, name of main page.png`;
- `C:\.projects\exocortex\saturn\.src\saturn left menu.png` — exact Saturn
  composition and geometry.

The Saturn-specific template is authoritative for the rail geometry and brand.
Its transparent purple planet asset is bundled into the Web production build.

## Entry state

- the authenticated owner shell and its six primary destinations exist;
- owner appearance preferences are persisted in PostgreSQL;
- desktop and mobile navigation use one React navigation tree;
- the root `.docs` directory is available as a read-only normative source.

## Implemented contract

- fixed 250 px black desktop rail whose rightmost pixel is a continuous white
  level-one boundary;
- template planet at its original crop, lowercase accent `saturn` wordmark and
  no additional health row inside the rail;
- primary rows start at y=285, use a 221×42 px box from x=18 to x=239 and
  display the label on the left with a stable two-digit ordinal on the right;
- the template identities are `Dashboard 01`, `Storage 02`, reserved `03`,
  `Drop Point 04`, `Shared 05`, `Trash 06` and `Settings 07`;
- active row uses an accent border, accent text and an external rectangular
  arrow without moving layout;
- hover uses `#111111`, accent text/border and transform-only growth; pressed
  state uses a short `.985` scale; reduced-motion removes transforms;
- Documentation and Logout remain unnumbered, unboxed and outside reordering;
- pointer drag/drop has before/after insertion feedback; `Alt+ArrowUp` and
  `Alt+ArrowDown` provide the keyboard alternative and update an ARIA live
  announcement;
- order is validated by the API and stored server-side as owner preference;
- fixed and auto-hide desktop modes are stored server-side under Appearance;
- auto-hide leaves an 18 px activation strip and removes hidden sidebar
  controls from focus navigation;
- at 720 px and below, an explicit menu button opens the same sidebar as an
  overlay; backdrop click and Escape close it.

## Exit state

- navigation order and mode survive reload and a new owner login;
- all six destinations remain present exactly once and retain their template
  ordinals after reordering;
- hidden desktop/mobile navigation cannot receive keyboard focus;
- sidebar rendering uses only Saturn assets and approved operational styling;
- migration `0015_sidebar_preferences` has an ordered rollback pair;
- type checks, unit tests, production build and desktop/mobile visual checks
  pass.

## Verification

1. Apply migration `0015_sidebar_preferences` to an existing Stage 6 database.
2. Reject missing, duplicate, unknown or non-six-item navigation orders.
3. Reload an authenticated page and confirm stored order and mode.
4. Reorder with pointer and `Alt+ArrowUp/Down`; confirm stable ordinals and PUT
   body.
5. Inspect fixed desktop, hidden/revealed auto-hide and 720/320 px overlay.
6. Check focus, Escape, backdrop, hover, active and reduced-motion states.
7. Run workspace lint, typecheck, tests and production builds.

Accepted DEV evidence (2026-09-02):

- migration `0015_sidebar_preferences` applied to the existing database;
- live authenticated GET/PUT/GET returned `fixed`, six unique destinations
  and the same persisted `updatedAt` value;
- a duplicate navigation order returned `400 invalid_preferences` and did not
  mutate the stored preference;
- desktop geometry measured a 250 px sidebar, main-content origin at 250 px,
  first navigation row at y=285 and six 42 px rows;
- mobile fixture at 390 x 700 measured a 250 px open overlay, visible backdrop
  and `aria-hidden=false`;
- hidden auto-hide measured sidebar x=-250, content x=18, activation strip 18
  px, `aria-hidden=true` and `inert`; reveal restored x=0 and removed both
  hidden-state attributes;
- workspace lint, typecheck, all workspace tests and production builds passed;
  the final validation error mapping additionally passed API lint, typecheck,
  tests, build and the live duplicate-order request.

Current destination set: Dashboard, Storage, Drop Point, Shared, Trash and
Settings.
Activity and Laboratory owner-Web views, their client API bindings and the
Files `Use in Laboratory` action were removed in migration `0016`. Audit and
Laboratory server capabilities remain available outside the left-menu UI.

## Rollback

- deploy the previous Web/API artifact;
- run the paired `0015_sidebar_preferences.down.sql` only after the previous
  artifact is active;
- rollback removes only the navigation-order and sidebar-mode preferences; it
  does not mutate resources, sessions, files or Storage Box bytes.
