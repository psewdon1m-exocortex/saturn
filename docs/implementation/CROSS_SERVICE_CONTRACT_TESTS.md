# Cross-service Settings contract tests

Saturn's ordinary build and tests require only the Saturn checkout. Production
TypeScript never reads sibling repositories. The Volt/Mastermind Settings
consumer checks live in `apps/web/integration`, outside the application source
and ordinary Vitest inventory.

Run `pnpm --filter @saturn/web test:consumers` with
`EXOCORTEX_CONSUMER_SOURCE_ROOT` set to the absolute directory containing
explicitly prepared `volt` and `mastermind` checkouts. Missing inputs fail the
integration run; they are not silently skipped. Record both source revisions
with its test output when qualifying the service tuple.

The reusable verification workflow accepts `volt-ref` and `mastermind-ref` for
this separate integration job. Standalone service CI does not infer another
service's branch or copy its source into the production image.
