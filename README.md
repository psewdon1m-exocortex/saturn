# Saturn

Saturn is the Exocortex storage gateway and operator-facing file service. The
implementation entry point is [docs/implementation/README.md](docs/implementation/README.md);
the complete target architecture is documented in
[docs/technical_solution_storage_gateway.md](docs/technical_solution_storage_gateway.md).

После обычной установки создайте в Synchronization pipeline для namespace
`saturn` и одноразовый Neptune setup code. В Settings → Backup нажмите
**Initialize Neptune** и введите код. Updater установит отсутствующий агент
или подключит существующий. Neptune и Gryphon также устанавливаются автоматически
после регистрации Saturn, настройки Kernel Register и доверия к релизам. `sudo saturn-install backup` (старое имя `vaultctl backup` также
поддерживается) устанавливает отсутствующий агент и остаётся резервным
CLI-сценарием. Расписание задаётся только в Synchronization.

## Verification

Install the pinned workspace dependencies and run the production-like suite:

```sh
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm verify:stage:13
python3 scripts/pre-push-gate.py --upstream-result success
```

The final command evaluates the versioned seven-area policy in
[.github/pre-push-gate.json](.github/pre-push-gate.json). GitHub Actions runs the
same policy after native verification on every push to `main` and before a tag
release can publish artifacts.

## Runtime storage profile

The bootstrap `STORAGE_*` values remain the first-start fallback. API and worker
also require the same protected writable `STORAGE_RUNTIME_CONFIG_DIR` (default
`data/storage-runtime`; production `/var/lib/vault/storage-runtime`). An owner
may validate and select another SFTP target in Settings → Security. This rebuilds
the active catalog for that independent target and migrates no file bytes. See
[runtime storage switching](docs/implementation/RUNTIME_STORAGE_SWITCHING.md).

## Gryphon integration

Saturn does not connect to Telegram directly. Gryphon owns bot tokens and
webhooks, then calls Saturn's authenticated `POST /internal/gryphon/command`
adapter. Connect bot tokens with `gryphon bot connect`; **Link Saturn function**
in the Bot connection Settings card selects one of those bots through the
service-scoped `GRYPHON_SOCKET_PATH`. The installer provisions
`/etc/gryphon/clients/saturn.token`; Saturn never receives a bot token. When the
function is connected but no Telegram user is bound, **Initialize bot** creates
the one-time `/link CODE` challenge directly in Settings; `gryphon link issue
saturn` remains the equivalent CLI fallback.
The same Settings card can ask the privileged Updater to check or install a
verified Gryphon Linux release.
After linking, use `/saturn drop`, `/saturn status` and `/saturn revoke` (or the
corresponding inline buttons).

The current six-service deployment, trust, recovery and acceptance contract is documented in [Deployment readiness](DEPLOYMENT_READINESS.md).
