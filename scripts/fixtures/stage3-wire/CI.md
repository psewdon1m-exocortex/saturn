# Ordinary CI inputs and qualification

`node scripts/ci-workspace-inputs.mjs --postgres-suite` runs the existing SQL
suites on disposable Linux PostgreSQL, SFTP and K4 inputs. The default Stage 13
entry also provisions these inputs when an operator has not supplied an owned
`STAGE3_CHAT_A_FIXTURE` manifest. Each Docker effect checks the engine and full
resource identity. The dump helper accepts only that fixture's current database;
it streams a real PostgreSQL custom archive. Cleanup joins only owned actors.
An unknown child outcome retains resources and fails admission.

Stage 13 writes `artifacts/verification/workspace-ci-accounting.json`, including
every case's current source SHA, status and conditional input hints. A successful
ordinary CI run may contain explicit `NOT_RUN` cases; these are never PASS.
`ordinaryCiAccepted` and `fullCiAccepted` are separate facts. Runtime diagnostic
scope still exits 2 after successful runtime checks and cannot accept quality.
Release publication requires complete qualification and refuses an ordinary-only
report. Source-bound native/archival evidence and owner dispositions must be
resolved in the combined release acceptance; an ordinary CI report cannot create
or approve those decisions.

`completion-clients.integration.test.ts` is an externally controlled receiver
fixture. Set `COMPLETION_RECEIVER=1` only when real native drivers will call it
and its controller will create `api-stop`. Starting an empty receiver is not a
native interoperability PASS. Other product regression tests retain their
assertions; this fixture is explicitly reported as NOT_RUN in ordinary CI.

The portable vectors in this directory preserve the recorded producer bytes and
SHA values. They cover wire contracts; they do not impersonate missing historical
readers, current native drivers, publisher signatures or release acceptance.
