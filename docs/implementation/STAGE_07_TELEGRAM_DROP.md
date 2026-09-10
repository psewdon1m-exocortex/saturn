# Stage 7 — Gryphon-mediated Telegram Drop access

Status: `SUPERSEDED AND MIGRATED`

Saturn still owns Drop codes, upload-only sessions, quotas, revocation and the durable upload pipeline. Gryphon now owns every Telegram-specific concern: bot tokens, webhook registration, update deduplication, callback data, outbound delivery and service-scoped identity binding.

## Active contract

- Gryphon calls `POST /internal/gryphon/command` over the private service network.
- Saturn authenticates the call with its dedicated bearer token and accepts the neutral `exocortex.telegram.command.v1` envelope.
- The adapter supports `menu`, `drop`, `status` and `revoke` and returns `exocortex.telegram.response.v1` actions.
- Gryphon proves that the actor is linked to the Saturn connection. Saturn records that actor on generated Drop challenges so later revocation remains identity-scoped.
- Saturn sends completion and brute-force notifications through Gryphon's authenticated service-scoped Unix socket.
- Connecting bot tokens remains a Gryphon root-CLI operation. The Bot connection card in Saturn Settings lists that Gryphon-owned pool and creates/removes the Saturn service connection. Once connected, **Initialize bot** requests a service-scoped, one-time `/link` challenge without exposing the Gryphon admin socket. The card also delegates Gryphon release checks and installation to the privileged Updater.

## Persistence migration

Migration `0027_gryphon_gateway` adds command-event idempotency. Migration `0029_remove_legacy_telegram` removes Saturn's old binding, link-challenge and update tables. Migration `0030_gryphon_settings_section` adds the service-control card without restoring any provider runtime. Historical migrations retain their original names so existing databases and rollback ordering remain valid.

## Verification

- Gryphon tests cover shared and distinct bots, isolated one-time bindings, update replay, callbacks, HTTP boundary authentication and secret redaction.
- Saturn Drop tests cover Gryphon-issued codes and identity-scoped revocation.
- Saturn API, web, config, database, deployment and recovery packages run in the normal repository test suite.
