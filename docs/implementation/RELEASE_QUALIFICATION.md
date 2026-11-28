# Execution accounting and release qualification

Ordinary CI keeps every assertion and its actual execution status. In the
current Linux workspace run, 2063 assertions pass and 98 are NOT_RUN. Neither
ordinary success nor the reviewed qualification below changes NOT_RUN into
PASS. `fullCiAccepted`, `fullQualificationAccepted` and `readyToDeploy` in the
original Stage 13 report keep their original meanings and values. The existing
`ci-workspace-accounting.mjs --require-full` check remains strict.

Release eligibility has an additional explicit, reviewed qualification for
those 98 identities. This is necessary for retained tests, Windows-only
execution, historical scoped predicates, an externally driven receiver, and
the owner's deferred performance target. The release workflow runs the full
ordinary quality and exact-image Stage 13 checks first, then runs
`ci-workspace-release-qualification.mjs` with the checked-in package8 manifest.
No required automatic regression is deleted or newly skipped.

The additional verifier refuses failed or diagnostic Stage 13 results,
incomplete closure, another commit/version, changed or unlisted tracked
source inputs, missing or duplicate case identities, changed test hashes,
unbound evidence, a changed runtime relative to the accepted F17 baseline,
and unknown dispositions. Source and evidence bytes are bound by SHA256. The
runtime comparison reads the historical Git objects and preserves binary
bytes; its only normalization is terminal CR/LF. The manifest and evidence
are reviewed QA attestations derived from retained local reports, not new
executions of those historical tests.

The current reviewed dispositions are:

| Scope | Count | Meaning |
|---|---:|---|
| Current managed-owner SQL/OS assertions | 8 | Separately executed on the current source with actual joined exit0; not execution inside the ordinary Linux workspace run. |
| Retained individual assertions | 85 | Actual earlier passed assertions, with current source/dependency impact review; not a current invocation PASS. |
| Retained historical scoped predicates | 3 | Original cycle9 retention and two independently continued registry recovery predicates. The old whole registry command failed; no missing numeric exit or fresh Vitest PASS is invented. |
| Externally controlled completion receiver | 1 | A controller entry, explicitly not a standalone native product assertion. Real client/content/lifecycle coverage is retained from the accepted native composition; this entry is not labeled PASS. |
| Owner-deferred sustained50files/s target | 1 | `WAIVED_BY_OWNER / PERFORMANCE_TARGET_DEFERRED`, not performance PASS. Integrity, source identity, retry and lifecycle checks are required. |

The receiver and waiver are limited to their exact case identities. Scoped
historical predicates are also limited to the three reviewed identities.
Unexpected conditional cases require new review; there is no fallback skip
list or ordinary-success override.

The release-qualification result reports
`QUALIFIED_WITH_EXPLICIT_RETAINED_CREDIT_AND_OWNER_DISPOSITIONS`, preserves
the ordinary counts and includes each non-PASS disposition. It is not a
claim that package8 is accepted or production is ready. Final signed-artifact
installation/discovery, the current joint user journey, complete claimed
data/identity/history readback, compatible rollback, normal drain, cleanup,
the release handoff and direct deployment approval remain separate gates.
