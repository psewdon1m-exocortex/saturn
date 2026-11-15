# CHAT-C — Pluto + host storage-verifier

Состояние: TARGETED CHAT-C TESTS PASS — 2026-10-14. Normal164/164 leaf cases, race21/21, FAIL0/SKIP0; builds/typecheck PASS. Внешний A15 integration receipt OPEN. K1 r2/K2 r2/K3 r2/K4 r1 сохранены.

## Принятые контракты и обмен

- **K1 r2, K2 r2, K3 r2, K4 r1 READY приняты.** Go capability parser ожидает revisions {K1:2,K2:2,K3:2,K4:1}. R1 originals/receipts не переписываются. Endpoint delete-plans/approve Pluto не вызывает.
- K1 r2 mutations/batch подключён к ordinary empty/metadata/clone caller: bounded coalescing, original singleflight, независимые per-item outcomes, individual fallback с теми же IDs.
- K4 protected registry **objects[] 1–16 реализован**; ровно одно exact совпадение, common owner/root/operation/intent identity, сохранён single-object формат. Весь registry witness перечитывается после hash/fsync.
- C20 engine включён в server check-in с согласованными именами Go JSON. Дополнительные network pressure counters остаются local diagnostics, без изменения server contract.
- CHAT-A подтвердил root workspace/lockfile/alias и optional Docker wiring. CHAT-C не менял эти общие файлы. Host dependencies: только Node built-ins + shared @saturn/contracts; tsup/typescript из catalog.
- Server adoption artifact A может служить источником reviewed binding/device/backend/receipt/namespace для protected Pluto profile. Автоматического доверия raw capabilities или silent enrollment activation нет.

## Реализованные собственные части

| Пункт | Реальный caller / результат |
|---|---|
| C02 | OpenIndexedSession общий для CLI и обычного Service; long-lived owner/index/admission; original recovery; pause/update/shutdown join/checkpoint; activation marker запрещает legacy fallback. |
| C03 | Linux inotify directories+file inodes, bounded watches/ingress, durable coalesced generations/debounce, targeted scans, gap/overflow/mount handling и periodic guarded fallback. Empty directories подключены. SQLite v8 additive, WAL-aware backup. |
| C05 | Negotiated ≤25 s long-poll с отменой по local dirty work, durable opaque cursor, обычный polling fallback и существующий gap rebootstrap. |
| C06 | Parent original singleflight, ≤500/4 MiB batches, confirmed parent refs/topological rounds, per-item outcomes; persistent bounded positive/negative cache, feed/policy invalidation. |
| C11/C12 | Versioned source/exclude policy, scope preview, NFC portable_v1/ASCII collision key, collision/invalid-name report, digest-bound offline apply + progress journal. Нет скрытых excludes, normalize, rename или remote delete. |
| C13 | Обычный per-root small_batch_mode; ранее реализованные immutable originals, subset/individual resume, aggregate accounting и recoverable disable; durable per-original retry подключён. |
| C14/C21 | Create-empty, доказанный metadata patch без смены contentVersion, authorized known-hash clone; exact publication ACK и capability/no-match fallback. |
| C15 | Early streaming ≥8 MiB: immutable pre-hash intent, 4 MiB chunks, ACK map, final SHA/source guard; counted reread on restart, без повторной отправки ACKed chunks. UNKNOWN/SOURCE_BUSY сохраняют original. |
| C16 | Durable classified retry, jitter/Retry-After/DEGRADED; process network admission, byte fairness+aging, published throughput/latency feedback, cooldown и cancellable bandwidth pacing при прежних hard limits. |
| C17 | Negotiated metadata gzip >16 KiB, compressed/expanded bounds; canonical hashes и binary content не меняются. |
| C18 | inspect/diagnostics/pause/resume/checkpoint/backup/migrate-plan/adopt; old/new binding/original inventory, paused exclusive apply, repeatable progress, WAL backups. Updater drain и writer/schema compatibility check для замены/rollback. |
| C20 | Engine status/check-in/TUI: phase, queue/capture/publication/recovery/failure, oldest dirty age/gap/wait, HTTP/capture counters. Local diagnostics добавляет transport pressure. |
| C22 host | Настоящий Linux Node >=24 package: authenticated HTTP/TLS, shared K4 parser, protected registry, pinned no-follow ancestor traversal, bounded SHA/fsync, exact source/path/owner recheck, cancellation/drain, entry point и README. |

## Compatibility и пределы

- File cap Pluto **256 MiB**, retention **10**, backup semantics сохранены. Source removal/exclude не удаляет remote copies. MOVE/delete/restore права не добавлялись.
- Optional features и batching OFF до explicit local configuration + qualified server capabilities. Inotify silence/mtime не предоставляют универсальный content proof.
- Старые sealed captures, operation IDs, receipts и batch membership сохраняются. Несовместимые originals не пересоздаются: adoption отказывает с сохранением состояния; source changes не мешают historical original recovery.
- v8 расширяет schema v7; старые writers отказывают при неизвестной schema. Feature disable не откатывает индекс. Неподдерживаемый binary rollback оставляет journal/previous binary для reconciliation.
- Host: Linux с /proc/self/fd; no-follow, one-hardlink regular files, protected UID files; registry/secret вне content roots. TLS обязателен вне loopback. Не исполняет shell, clone, upload, rename/delete и не выдаёт ownership. Максимум 4 active hashes / 64 KiB buffer / 1 GiB request ceiling / ≤30 s deadline между syscalls. In-progress filesystem syscall не прерывается мгновенно.
- Host verification failure не разрешает пропустить проверку. Readback fallback и executor/registry handoff — интеграция CHAT-A. SHA сам по себе не доказывает directory durability/fencing.
- Добавлена pinned Go dependency golang.org/x/text v0.43.0 для NFC (официальные proxy/sumdb, без скачивания/установки modules). Release packaging и runtime notices необходимо регенерировать штатным builder на отдельно разрешённом этапе.

## Собственные изменённые пути

- pluto/: cmd/pluto/main.go; daemon/session/config/service/TUI/lifecycle/policy/update; syncstate observation, additive v8, parent/mutation/stream transport, retry/admission/status; syncproto/name_codec.go; go.mod/go.sum; README.md и docs/indexed-daemon.md.
- saturn/packages/storage-verifier/: package manifest, tsconfig, README, src/{authority,secure-files,verifier,server,main,index}.ts.
- Только собственные status/journal и .audit/2026-10-14/chat-c-baseline/ evidence вне этих областей. Neptune и общие Saturn implementation/contracts/adapters/manifests не редактировались.

## Целевая приёмка после разрешения оператора

Новое поручение оператора разрешило целевые тесты группы C и цикл тест → исправление → повтор. C00–C16 выполнены на Linux fixtures, включая native inotify overflow/65 536 watches/unmount/permission, SQLite migration crash/ENOSPC, настоящие daemon CLI/restart и Linux verifier entrypoint. Все окончательные selected tests прошли; подробные подварианты, команды, ранние FAIL, исправления и SHA сохранены в отчёте.

OPEN: A15 integration receipt с настоящим Saturn API, server-only A01/A07/A08/A11/A12 proofs, отдельная network matrix. Общий regression, installed release/updater/deployment, performance benefit и endurance не запускались; O01–O03 вне задания. Собственные caller fixtures не заменяют server receipt.

Отчёт: [REPORT.md](C:/.projects/exocortex/.audit/2026-10-14/targeted-tests/chat-c/run-193115-c7f8dc76/REPORT.md). [Все окончательные cases](C:/.projects/exocortex/.audit/2026-10-14/targeted-tests/chat-c/run-193115-c7f8dc76/RESULTS.md). [Журнал приёмки](C:/.projects/exocortex/.history/2026-10-14-targeted-tests-chat-c.md).

Исправлены выявленные compile/typecheck failures, verifier stalled-body shutdown, HTTPS qualification до adopt, reviewed snapshot binding/restart journal, session status counters и гонка Dispose→PruneDisposed→повторный Dispose. Последняя объясняет прежний intermittent sql.ErrNoRows: deterministic regression FAIL→fix→PASS, затем полный affected normal и race PASS.

Для A15: actual `C-native-final/pluto-k3-checkin.json`, `C-native-final/pluto-catalog-caller.json`, `C-host-final/verifier-k4-http.json`; точные `C00/source-final.json` и `C00/binary-manifest.json` находятся в указанном run directory. Receipt A15 этим чатом не выдавался.

Документация: [Pluto indexed daemon](C:/.projects/exocortex/pluto/docs/indexed-daemon.md), [host verifier](C:/.projects/exocortex/saturn/packages/storage-verifier/README.md).
Журнал: [2026-10-14-parallel-pluto-verifier.md](C:/.projects/exocortex/.history/2026-10-14-parallel-pluto-verifier.md).

## 2026-10-14T17:13:51.6829278+03:00 — предыдущая передача до разрешения тестов

- K1 r2 принят в Go parser и mutations/batch caller; K2 r2/K3 r2/K4 r1 неизменны. Shared codec vectors от A прочитаны, не исполнялись.
- C12/C18 дополнительно подключён explicit binding transition через migrate-plan/adopt для уже активного профиля. SQLite profile_rebinding хранит old/new binding, курсор и unmatched count; baseline переносится только после HTTPS negotiation + complete current snapshot и совпадения node/namespace/content proof. Изменённые объекты остаются конфликтами, original intent/receipt JSON не меняется. Inspect показывает progress/unmatched.
- Исходный fingerprint: 201 файл Pluto. Собственные изменения: 40 изменённых + 24 новых файла Pluto, 9 новых файлов host package. 80 исходных тестовых файлов совпадают с baseline; удалённых исходных файлов нет. Точный список SHA-256: .audit/2026-10-14/chat-c-baseline/final-owned-changes.json.
- gofmt применён к 60 изменённым Go source files; compiler/typechecker/test runner не запускался. Ручная текстовая сверка imports/contracts/ownership не заменяет выполнение.
- Implemented / unvalidated. Code handoff открыт для интеграционного чтения CHAT-A; отдельные runtime gates выше остаются OPEN.
