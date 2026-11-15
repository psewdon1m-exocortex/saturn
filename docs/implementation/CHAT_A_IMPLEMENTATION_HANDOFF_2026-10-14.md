# CHAT-A — Saturn: implementation handoff, 2026-10-14

Статус: серверный код реализован и подключён; runtime qualification **OPEN**. Основание — [inventory](IMPLEMENTATION_CHANGE_INVENTORY_2026-10-14.md), пакет CHAT-A. Журнал: [2026-10-14-parallel-saturn.md](../../../.history/2026-10-14-parallel-saturn.md). Входное dirty дерево сохранено; список собственных изменений относительно входных SHA находится в `.history/2026-10-14-parallel-saturn-baseline/implementation-files.json` в корне workspace.

Тесты, lint/typecheck, сборки, применение миграций, запуск API/worker/daemon, контейнеры, установка verifier, deployment и 6h не выполнялись. Статическая сверка исходников и fingerprints не являются PASS этих gates.

## Реализованный серверный пакет

| Область | Production entry / поведение |
|---|---|
| C05/C17 | Guarded HTTP: bounded long-poll до 25 s, исходный cursor запечатывается только при ответе; JSON gzip с compressed/decoded/depth/CPU bounds; binary не сжимается |
| C06/C13/C14 | Folder batch с previous refs и независимыми outcomes; прежний small-file-batch transport сохранён; empty/metadata mutations и metadata batch |
| C07/C09/C10 | Namespace original → whole-root claim → physical effect → атомарные catalog/feed/receipt; stable node IDs, CAS, move/case-only, leaf quarantine/restore, version-bound metadata, authorized clone, delete approval |
| C08/C16 | Durable backend queue API/worker, один physical writer, общие read slots, capacity admission, bounded task bytes, drain/confirmed-close/handoff; UNKNOWN не переигрывается |
| C11/C12/C18 | Durable codec/policy, portable vectors, before-IO name gate для старых v2 routes, offline plan/adoption populated root, progress/custody digest, новая binding/manifest receipt, recovery/rollback planning |
| C15 | Prepare до whole SHA, fixed chunks/ACK, immutable source witness, final seal; старый upload verify/CAS executor с тем же operationId |
| C20 | Root diagnostics, received/verified/published раздельно, oldest pending, shared queue/read pressure, durable written/copied totals; process SQL/storage time; Pluto engine check-in schema |
| C21/C22 | Root-scoped content lookup и independent clone; protected verifier client/registry, local verifier primitive; host package CHAT-C подключён в workspace/lockfile/alias и optional Docker target |
| C23 | Существующий scrub: byte/time deadline, cancellable ranges, low-priority shared read slot, progress, original-backed availability event; повреждение historical version не делает current version недоступной |

Текущие контракты: **K1 r2 / K2 r2 / K3 r2 / K4 r1**, [точные wire shapes](PARALLEL_SYNC_CONTRACTS_2026-10-14.md). CHAT-B/C приняли r2. В исходниках Neptune прочитан caller server approval и durable receipt; его runtime не проверялся. READY относится к интерфейсу; состояние соседних реализаций — в [общем checklist](PARALLEL_INTEGRATION_CHECKLIST_2026-10-14.md).

В v3 raw adapters и guarded coordinators используют opt-in exact paths: имя не trim/NFC-normalize при IO, leading spaces и Unicode scalars сохраняются. Прежний legacy normalizer не изменён; noncanonical legacy mutation в v3 явно отклоняется до IO. Whole path ограничен 4096 UTF-8 bytes. PAUSED root допускает restart для продолжения уже принятых originals.

## Матрица mutation callers

Все строки относятся к зарегистрированному guarded root. Незарегистрированные legacy области сохраняют свои маршруты, но physical effects при v3 проходят через общий backend executor. Root объявлен **managed-exclusive**: прямые внешние writers не поддержаны.

| Caller / операция | Маршрут / явное ограничение |
|---|---|
| Windows/Pluto guarded create-directory | `directories/ensure-v2`, batch → существующий folder-v2 original/CAS |
| Windows/Pluto guarded upload/overwrite | catalog-upload-v2, small batch и stream → прежний verified publication; старые originals не преобразуются |
| Windows move / rename | namespace move, version CAS, parent topology/membership, stable IDs; target должен быть свободен |
| Windows delete | leaf/postorder quarantine; для approved plan сервер связывает exact items/versions/actor/binding/policy; массовый recursive physical delete отсутствует |
| Windows restore | namespace restore только для прежнего опубликованного quarantine original и свободного target |
| Windows/Pluto empty, metadata, known-hash content | namespace create-empty / metadata-patch / clone-content; отдельный clone feature gate; только authorized same-root version |
| Pluto move/delete/restore/approval | Явно `forbidden`, backup source disappearance не удаляет серверные copies |
| Owner UI move, file copy, leaf trash, restore | `GuardedOutsideFolderService.ownerAction` → тот же namespace coordinator; owner credentials перепроверяются в SQL |
| Owner UI folder create внутри root, обычный upload/version restore, recursive folder copy, cross-root copy/move | Явный guarded refusal через mutation guard до physical IO; использовать поддержанные guarded primitives. Эти legacy callers не объявляются покрытыми |
| WebDAV/device обычные MKCOL/PUT/MOVE/COPY/DELETE | Legacy FileService/authority guard отказывает до storage effect; прочитать capability и использовать guarded sync endpoints. Owner authority не выводится из WebDAV credential |
| Drop/backup import внутрь managed root | Legacy mutation guard/storage fence отказывает. Обычные незарегистрированные Drop/backup области продолжают работать |
| Reconciliation старых операций | Guarded originals исключены из legacy interrupted-operation repair. Для них original status / `recovery-plan`; folder repair dispatch использует существующие 0059/0060 primitives |
| Scheduled purge / age cleanup | Guarded candidates исключены и повторно проверяются до effects; private active/history/receipts по возрасту не удаляются. Автоматический guarded history purge — unsupported, retained bytes видны в diagnostics |
| Integrity scrub | Internal availability mutation; нет HTTP маршрута для maintenance credential. Незарегистрированные roots используют прежний quarantine |
| Storage catalog import / external reconciliation | План с guarded paths или ancestors целиком отклоняется `storage_guarded_import_unsupported` до DML; readonly analysis остаётся доступен |
| Full recovery restore | Existing durable guarded evidence запрещает legacy restore; recovery-plan/qualified offline repair. Нет автоматического удаления guards/originals для восстановления |
| Storage profile switch | Runtime profile guard блокирует не соответствующий manifest generation; offline drain/fence/handoff/requalification обязательны |

Явный unsupported здесь — часть требуемой C07 матрицы, а не скрытый fallback. Полная поддержка всех legacy функций не заявляется.

## Durable state и эксплуатационные границы

Добавлены миграции **0062–0066**; ранее установленные **0057–0061 не редактировались**. Они вводят backend queue/read slots, namespace policy/approval/originals, stream state, offline adoption/handoff и admission/write guards. Down migrations отказывают при retained originals, enrollment или adoption evidence; они не очищают данные ради rollback.

Backend: один effect writer, максимум 128 queued/running/unknown effects, 1 GiB queued/reserved bytes; chunks в очереди до 4 MiB. На backend допускаются до четырёх pending content jobs, из них до двух >8 MiB. Три shared read slots + writer, максимум один scrub reader; aged scrub получает возможность чтения. Disk floor 256 MiB проверяется перед allocating effect, фактически занятые history bytes входят в free-space pressure. DONE/REJECTED tasks освобождают payload bytes, сохраняя ID/hash/result; UNKNOWN bytes и original evidence сохраняются. Требуется достоверный `statFs` backend; отсутствие disk-capacity capability не означает бесконечный запас.

Исторические версии не удаляются новым кодом автоматически. При исчерпании места admission останавливается; cleanup требует отдельного qualified lifecycle. Guarded retention следует считать защитой сохранённых версий, а не доказанным автоматическим сокращением истории до десяти. Client Pluto ceiling 256 MiB и его retention policy не повышались.

SQL expiry/heartbeat не передают владение. Чистый shutdown закрывает admission, дожидается root slots и effect queue, закрывает все physical clients (включая leased/handshake), затем записывает STOPPED. Ошибка SQL/drain/connection closure оставляет владение неподтверждённым. При crash оператор подтверждает закрытие старых каналов и отзыв старых credentials; `handoff` сохраняет RUNNING как UNKNOWN, QUEUED отклоняет до исполнения. Неопределённые originals требуют conclusive evidence; автоматического повторения IO нет.

## Подготовка окружения после отдельного разрешения

1. Подготовить backup и совместимые Saturn/client packages; позже применить additive migrations 0062–0066. Ничего из этого в текущем запросе не исполнялось.
2. Сохранить исходную role topology: отдельные runtime, writer login, NOLOGIN writer owner и migration/table owner, без membership login → owner. Runtime не должен получить EXECUTE новых SECURITY DEFINER commands.
3. В reviewed deployment role plan назначить writer owner владельцем новых `sync_backend_command(text,jsonb,jsonb)`, `sync_namespace_command(text,jsonb,jsonb,jsonb)`, `sync_stream_command(text,jsonb,jsonb,jsonb)`, затем дать EXECUTE writer login. Owner нужны DML права на backend queue/read slots, namespace/delete-plan/stream state и прежний catalog/feed/journal, SELECT root policy; EXECUTE helper `sync_namespace_authorize(uuid,text,jsonb)`. Runtime нужны readonly diagnostics/policy tables и DML `sync_scrub_progress`; policy/migration/handoff — только offline operator. Табличные guards защищают новые authority tables даже при старых широких default grants.
4. Manifest v3 содержит десять approved SECURITY DEFINER functions (семь прежних для v2 и три выше) с точными source hashes. `saturn.guarded-qualification.v3` должен подтверждать supported/unsupported writers, private lifecycle, single writer/handoff, small batch transport и точный список features. Код не создаёт фиктивный qualification receipt.
5. Backend fence должен связывать реальные profile ID/revision/config digest, credential digest, generation, oldExecutorsDrained, oldCredentialsRevoked и protectedAncestorsVerified. Установка этого JSON без реального fencing не является квалификацией.
6. При verifier: установить отдельно package CHAT-C у конечного диска, настроить HTTPS (HTTP только loopback), bearer secret и operator-mounted protected registryDirectory. Saturn пишет owners и immutable operations/objects, host повторно проверяет их до/после чтения. Каталоги и secret должны быть защищены; SFTP shell/checksum capability не предполагается. До установки verifier остается `null`, используется обычный bounded readback.

Local verifier требует явного ownership callback и отказывает без него. Host module Linux-first использует pinned no-follow handles; local adapter использует no-follow/stable-file checks при managed-exclusive custody. `file-sync` подтверждает file fsync, не directory durability. Ошибки identity/scope/hash не становятся успешной verification; fallback разрешён лишь для unavailable/unsupported/capacity/cancellation и сам заново читает bytes.

## Offline CLI

Entry: `pnpm sync:lifecycle <command> <protected-config.json> [reviewed-artifact.json]`. Это инструкция для будущего разрешённого этапа, команда сейчас не запускалась.

Config:

```json
{
  "schema": "saturn.sync-lifecycle.v1",
  "rootId": "<existing canonical root UUID>",
  "databaseUrlFile": "/protected/migrator-url",
  "manifestFile": "/protected/runtime-v3.json",
  "outputDirectory": "/protected/lifecycle-output",
  "codec": "portable_v1",
  "policyHash": "<reviewed policy SHA256>",
  "storage": {"kind": "sftp", "configFile": "/protected/storage-config.json"}
}
```

Local storage alternative: `{kind:"local",root:"/absolute/root",custodyFile:"/protected/custody.json"}`. Custody schema `saturn.local-backend-custody.v1`: backendIdentity, backendGeneration, fenceReceiptSha256, absolute root, device/inode decimal strings. Реальный root проверяется; direct writers должны быть остановлены. Production RuntimeStorageManager остаётся SFTP composition; local adoption/verifier primitive не объявляет новый local runtime deployment квалифицированным.

Config/proofs/entries — абсолютные защищённые файлы, без symlink/hardlink; на POSIX private mode. Output создаётся exclusively, fsync, без credentials. Для самого первого root CLI допускает v3 manifest `roots:[]`; runtime по-прежнему не принимает пустой root manifest. Existing roots в manifest не удаляются.

| Команда | Реальное действие |
|---|---|
| inspect / diagnostics | Readonly root/policy/backend/original state → protected artifact |
| pause | PAUSED admission для новых originals; уже принятые операции могут завершаться |
| checkpoint | Snapshot pending state и `checkpointComplete`; не выдаёт pending bytes за publication |
| backup | pg_dump под exclusive maintenance с TLS/options исходного URL; защищённый dump и digest |
| migrate-plan | Readonly consistent catalog snapshot в NDJSON; tree SHA, epoch/binding/seq, выбранный codec/policy, до 500 подробных blockers, максимум 200000 nodes / depth128 |
| adopt | Exact reviewed plan + qualification/fence; STOPPED backend; физическая membership/hash сверка и durable progress; init metadata/upgrade guard/activation/new binding; receipt и новый manifest |
| resume | ACTIVE при согласованной policy и отсутствии unresolved original/generation state |
| rollback-plan | Совместимость feature/binary rollback; ничего не удаляет и не понижает schema |
| handoff | Reviewed `saturn.backend-handoff.v1`, prior generation/owner/fencing, new generation/fence SHA, oldConnectionsClosed; сохраняет UNKNOWN, не запускает owner |
| recovery-plan | Классифицирует original transport/namespace/folder repair и unresolved effects; не повторяет physical IO |
| repair-folder | Передаёт exact reviewed `saturn.offline-folder-revalidation-plan.v1` и SHA существующему revalidate-guarded-folders CLI; ограничения его платформы/role plan сохраняются |

Последовательность existing-root transition: pause → завершить принятые originals → checkpoint/backup → остановить API/worker и подтвердить STOPPED/fence → migrate-plan → review blockers/digest → adopt → установить созданный manifest → после qualification запустить совместимые сервисы → клиентский offline adopt сохранённого server receipt + HTTPS capability сверка → resume. Несовместимые имена требуют отдельного guarded rename под старым codec и нового плана; массового автопереименования нет.

Resume adoption использует прежние original IDs, entries SHA и exact custody/qualification digest. После инициализации root progress не переносится на другой backend generation. APPLIED plan возвращает сохранённый receipt; потерянный output manifest восстанавливается без повторных IO. Plan-only не пишет в пользовательский root. Полный metadata backup не заменяет physical storage backup.

## Оставшиеся validation gates

- TypeScript/build/SQL migration qualification и обратимость на disposable data; новых тестов здесь не запускали.
- All-writer negative paths, API/worker overlap, ACK loss, crash/fence/UNKNOWN, shared queue/read/disk limits и shutdown при зависшем SFTP.
- Long-poll cursor replay/gap/cancel, gzip bounds, independent batch outcomes, original replay и C#/Go wire acceptance K1 r2.
- Populated/legacy/ACTIVE adoption, interrupted resume, codec collisions, preserved credentials, incompatible rollback refusal.
- Real verifier host install/authority/no-follow/fsync/cancel/fallback; local/remote clone independent identity.
- Scrub deadline/fairness/current-versus-history corruption, retention pressure, diagnostics redaction и measured performance.
- End-to-end и полный regression остаются отдельным разрешаемым этапом. **6h запрещён до отдельного явного указания.**
