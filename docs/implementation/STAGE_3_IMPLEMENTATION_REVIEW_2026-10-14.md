# Этап 3: приёмка реализации CHAT-A / CHAT-B / CHAT-C

> Продолжение от 2026-10-14: по поручению оператора внесены доработки R02–R05 и ограниченная оптимизация R01. Их итог и ограничения описаны в [отчёте реализации](C:/.projects/exocortex/saturn/docs/implementation/STAGE_3_REMEDIATION_REPORT_2026-10-14.md). Исходная приёмка ниже сохранена как входной гейт; новые изменения не тестировались, причина исторического timeout R01 остаётся OPEN.

Дата: 2026-10-14, Europe/Istanbul, UTC+03:00. Проверка исходников начата в 18:07:59; контроль основных evidence-файлов — 18:16:12.

**Решение: полное соответствие требованиям пока не принято.** Основной объём подключён к рабочим точкам вызова, но C01 остаётся незавершённым, а статическая проверка выявила ещё четыре конкретных несоответствия. Отсутствие тестов само по себе не используется как доказательство дефекта реализации.

Этап ограничен чтением исходников и документацией. Тесты, сборки, typecheck/lint, применение миграций, native/product runs, установка и deployment не выполнялись. Сетевые правки параллельного чата исключены; они не являются ни основанием приёмки, ни замечанием к A–C. O01–O03 не входят в обязательную реализацию. Шестичасовой прогон не разрешён.

## Основание и статус источников

- Требования: [инвентаризация C01–C23](C:/.projects/exocortex/saturn/docs/implementation/IMPLEMENTATION_CHANGE_INVENTORY_2026-10-14.md), прежде всего «Изменить» и «Выход по коду». Её старый заголовок «реализация не начата» описывает состояние документа на этапе 2, а не нынешнее состояние кода.
- Интерфейсы: [K1 r2 / K2 r2 / K3 r2 / K4 r1](C:/.projects/exocortex/saturn/docs/implementation/PARALLEL_SYNC_CONTRACTS_2026-10-14.md). A, B, C подтвердили одинаковые revisions. Старые промежуточные запросы A к B/C по delete approval, adoption и verifier objects закрыты поздними записями.
- A: [статус](C:/.projects/exocortex/saturn/docs/implementation/parallel-2026-10-14/CHAT-A.md), [handoff](C:/.projects/exocortex/saturn/docs/implementation/CHAT_A_IMPLEMENTATION_HANDOFF_2026-10-14.md), [журнал](C:/.projects/exocortex/.history/2026-10-14-parallel-saturn.md). Финал — IMPLEMENTED / UNVALIDATED.
- B: [статус](C:/.projects/exocortex/saturn/docs/implementation/parallel-2026-10-14/CHAT-B.md), [handoff](C:/.projects/exocortex/neptune/docs/CHAT_B_IMPLEMENTATION_HANDOFF_2026-10-14.md), [журнал](C:/.projects/exocortex/.history/2026-10-14-parallel-neptune.md). Финал — IMPLEMENTED / UNVALIDATED, C01 OPEN.
- C: [статус](C:/.projects/exocortex/saturn/docs/implementation/parallel-2026-10-14/CHAT-C.md), [Pluto handoff](C:/.projects/exocortex/pluto/docs/indexed-daemon.md), [verifier](C:/.projects/exocortex/saturn/packages/storage-verifier/README.md), [журнал](C:/.projects/exocortex/.history/2026-10-14-parallel-pluto-verifier.md). Финал — IMPLEMENTED / UNVALIDATED.
- [Общий checklist A](C:/.projects/exocortex/saturn/docs/implementation/PARALLEL_INTEGRATION_CHECKLIST_2026-10-14.md) использован как карта, а не как независимое доказательство: строки REPORTED дополнительно сопоставлены с кодом.

## Замечания, мешающие полной приёмке

### R01 — C01: причина historical retained-recovery timeout не установлена

**Приоритет: обязательный незакрытый пункт. Владелец: B.**

Требование C01 — доказанная причина задержки и адресное исправление с bounded progress, сохранением generations/receipts/hardlink uncertainty. Реализованы phase timing/SQL/backlog counters и reuse schema preflight при неизменном schema_version. Сам B прямо фиксирует, что это не доказывает причину исторических 300 секунд.

Следовательно, C01 нельзя считать выполненным ни по отчёту, ни по коду. Сейчас нельзя подменить отсутствующее доказательство утверждением, что schema caching устранил исходный отказ.

Закрытие: после отдельного разрешения на динамическую диагностику установить место задержки на сохранённом профиле, затем определить необходимую адресную правку. Очистка профиля/inbox и увеличение timeout не являются закрытием. До этого статус OPEN обоснован условиями самой инвентаризации.

### R02 — C02 и связанный C07: guarded Pluto не сохраняет retention 10

**Приоритет: P1. Владельцы: A — серверная реализация; C — интеграционный контракт Pluto.**

Требование C02 явно сохраняет backup semantics и десять версий. В legacy цепочке [DeviceService.enforcePlutoRetention](C:/.projects/exocortex/saturn/packages/sync/src/device.service.ts:127) вызывает `limitVersions(...,10)`; этот вызов подключён к legacy Pluto upload. В новом daemon используется `OpenIndexedSession` и guarded catalog/stream/mutation API. Их публикация не вызывает эквивалентный guarded retention.

Старый [FileService.limitVersions](C:/.projects/exocortex/saturn/packages/file-core/src/file.service.ts:1214) начинает с `catalogMutationGuard.assertOutside`, поэтому его нельзя просто вызвать для активированного root. Legacy purge также отказывает для guarded candidates. Handoff A прямо признаёт, что automatic guarded history purge unsupported и история сохраняется до давления на диск; одновременно отчёт C говорит «retention 10 сохранён».

Ожидаемое следствие по коду: после достаточного числа обновлений одного файла ограничение в десять активных версий не обеспечено; история занимает место, а затем admission может остановиться. Это пробел реализации, не только отсутствие теста.

Необходимая правка: guarded retention coordinator/maintenance original, который учитывает текущую версию, десять сохраняемых версий и pins от активных originals/receipts/clone/recovery. Очистка должна быть возобновляемой, согласованной с единственным backend writer и catalog/receipt. Нельзя закрывать пункт ослаблением existing guards или удалением по одному возрасту. Если требуется изменить сам продуктовый retention, это отдельное изменение требования оператором.

Будущий выходной гейт: более десяти последовательных публикаций, рестарт во время очистки, активный pinned original; политика выполняется без удаления текущих/pinned bytes и без остановки роста истории только за счёт заполнения диска. Сейчас сценарии не запускались.

### R03 — C19: pending update journal не проверяется обычным startup

**Приоритет: P1. Владелец: B.**

В [WindowsUpdateTransaction](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsUpdateTransaction.cs:72) есть staged swap/MSI, persistent journal, health process и rollback. Но [App.OnStartup](C:/.projects/exocortex/neptune/src/Neptune.Windows/App.xaml.cs:28) запускает health только по специальному `--update-health`; обычный запуск переходит к `new MainWindow(profile).Show()` без проверки `installed`/`previous-retained`/другого незавершённого journal. Recovery вызывается при следующем apply, а не как обязательный startup gate.

Конкретный сценарий: helper аварийно завершается после установки нового payload, до успешного health/фиксации `healthy`; пользователь запускает приложение из target обычным способом. Новый GUI и далее writer могут работать до разрешения pending update transaction. При следующем apply `Recover` способен восстановить предыдущий payload без повторной проверки совместимости с состоянием, которое уже мог записать новый writer. При разрыве portable swap, когда target временно отсутствует, нужен доступный recovery entry point из сохранённого helper/launcher, а не ожидание запуска отсутствующего target exe.

Необходимая правка: общий startup gate для GUI и profile-command до любых writable действий; обнаружение и завершение/откат сохранённой update transaction отдельным helper; проверка совместимости rollback с текущим состоянием и публикациями. Сохранять previous payload до подтверждённого health. Добавить понятный путь восстановления после перезапуска ОС на каждой границе swap/MSI.

Будущий выходной гейт: остановка helper после каждого durable шага, обычный запуск после рестарта, запрет writer до решения journal; после допустимого rollback открывается совместимый профиль. Это статический вывод о доступном пути, не выполненный crash-test.

### R04 — C12: Go NameCodec расходится с C#/TypeScript

**Приоритет: P2. Владелец: C; A — общий вектор контракта.**

В [name_codec.go:33](C:/.projects/exocortex/pluto/internal/syncproto/name_codec.go:33) выполняется двойной `TrimPrefix(TrimPrefix(stem,"COM"),"LPT")`. Для `COMLPT1.md` stem превращается сначала в `LPT1`, затем в `1`; Go отвергает имя как reserved device name. TypeScript `syncNameKey` и C# `SyncNameCodec` проверяют только непосредственный `COM`/`LPT` + одна запрещённая цифра и такое имя принимают.

Это вывод из конкретных выражений, без запуска функции. Требование единой спецификации C#/Go/TS не выполнено для данного случая. Возможное следствие — допустимый по серверу путь блокирует Pluto portable migration/sync.

Необходимая правка: снимать ровно один выбранный prefix либо проверять точную форму reserved name; добавить общий vector `COMLPT1.md` → accepted/key `comlpt1.md` и соседние случаи. Выполнение vectors оставить отдельному этапу проверок.

### R05 — C08/C16: metadata IO не входит в общий backend read admission

**Приоритет: P2. Владелец: A.**

Требуется общий бюджет storage slots API/worker. В [DurableBackendExecutor](C:/.projects/exocortex/saturn/packages/storage/src/durable-backend-executor.ts:124) `openRead` получает SQL read slot, но `stat`, `list`, `exists`, `statFs` напрямую делегируют в raw adapter. Обёртка `BackendCheckedStorage` проверяет профиль, но не добавляет admission к этим методам.

[SftpStorageAdapter](C:/.projects/exocortex/saturn/packages/storage/src/sftp-storage.adapter.ts:53) берёт соединение из собственного process-local pool для lstat/readdir/statvfs. При параллельной работе API и worker такие вызовы могут выполняться сверх общего числа read slots и конкурировать с transfer/scrub без общего учёта. Единственность effect writer этим замечанием не опровергается; незавершён именно общий бюджет всех storage обращений.

Необходимая правка: учитывать metadata IO в bounded общем backend admission (в том числе при shutdown), с отдельным пределом/приоритетом при необходимости; избежать повторного захвата слота внутри уже admitted операции writer/verification. Отражать metadata wait в diagnostics.

Будущий выходной гейт: одновременные API/worker listing/stat, upload и scrub соблюдают общий лимит и не вытесняют recovery. Сейчас нагрузка не создавалась.

## Матрица C01–C23

«Путь найден» означает наличие связанной реализации и осмысленных ограничений при статическом чтении; это предварительная приёмка конструкции, не утверждение об отсутствии всех дефектов и не runtime PASS. Столбец не подменяет открытую последующую проверку компиляции/поведения.

| Пункт | Решение этапа 3 | Что подтверждено / что мешает |
|---|---|---|
| C01 | OPEN | Инструментация присутствует; доказанная причина и адресное исправление исходного отказа отсутствуют — R01. |
| C02 | Частично | Service.runBackup → OpenIndexedSession, activation fence и close/checkpoint связаны. End-to-end retention 10 отсутствует — R02. |
| C03 | Путь найден | LinuxObserver подключён через BeforeClaim/ObserveEntry; durable dirty generations, gap и targeted scan, periodic fallback. Реальный inotify/crash ещё не проверен. |
| C04 | Путь найден | Event inbox с quiet/max-age и generation CAS; volume reader/cache/mutex; отдельные subscription cursors; native qualification открыта. |
| C05 | Путь найден | Серверный bounded wait и клиентские callers/feed cursor есть. Сетевое восстановление и работа сетевого чата здесь не оцениваются. |
| C06 | Путь найден | Folder batch, parent refs/топология, cache/singleflight и individual originals подключены. |
| C07 | Условно по заявленной coverage | Общие namespace primitives и явная writer matrix есть; неподдержанные legacy paths отказывают до effects. Retention R02 остаётся пробелом. Нельзя объявлять все прежние UI/WebDAV/import/restore возможности поддержанными. |
| C08 | Частично | Durable owner/effect queue/drain/STOPPED и read slots есть; metadata IO обходит общий бюджет — R05. |
| C09 | Путь найден | Stable-ID move planner, native/parent proof, CAS и обновление namespace/B; неоднозначность не превращается в разрешение MOVE. |
| C10 | Путь найден | Proven absence/postorder, durable preview/approval, server registration K1 r2 до effect, receipt и generation ACK. |
| C11 | Путь найден | Versioned excludes/scope preview, continuation, сохранение remote copies, ограничения pending originals. |
| C12 | Частично | Binding/codec/migration artifact подключены; C#/Go/TS расходятся на COMLPT1 — R04. |
| C13 | Путь найден | Ordinary opt-in, missing-only subset с прежними individual IDs, recovery при отключении. Automatic ON остаётся закрыт benefit gate. |
| C14 | Путь найден | Create-empty/metadata-patch через durable mutation; metadata proof и capability fallback предусмотрены. |
| C15 | Путь найден | Immutable pre-hash identity, early chunks, ACK map, final seal и старый verified CAS. Неопределённый source/physical outcome остаётся deferred по требованию. |
| C16 | Частично, сетевой блок вне оценки | Client resource/byte scheduling и durable schedule присутствуют; общий server storage budget неполон — R05. |
| C17 | Путь найден | Negotiated metadata gzip, encoded/decoded bounds, отдельные binary bytes и неизменный canonical intent. Сетевые доработки этой области не оцениваются. |
| C18 | Путь найден | Реальные profile/lifecycle commands, WAL-aware backups, reviewed binding adoption, continuation и writer/schema fences. Crash/upgrade/rollback поведение не проверено; update startup defect отдельно в C19. |
| C19 | Частично | Portable/MSI apply, подписи, backup и journal есть; нет обязательного pending-update startup gate — R03. |
| C20 | Путь найден | Phase/SQL/backlog/resource diagnostics, mapping status и Pluto check-in wired; unknown backend bytes не объявляются published. |
| C21 | Путь найден | Authorized same-root lookup, immutable reference, independent copy/hash/CAS и client fallback; реальная экономия не измерена. |
| C22 | Путь найден | Реальный Linux verifier package, registry objects[], pinned no-follow traversal, hash/fsync, client integration/readback fallback. Установка и квалификация не требовались на этой фазе. |
| C23 | Путь найден | Scrub byte/time/range progress, low-priority reads и guarded availability mutation. Общий metadata budget связан с R05; runtime corruption/fairness открыты. |

## Ограничения, которые не следует смешивать с отсутствующей реализацией

- Явный отказ неподдержанного writer входит в требование C07. Поэтому отсутствие recursive/cross-root legacy copy или legacy full restore не автоматически является скрытым обходом guards. Но включение guarded root меняет доступный пользователю набор операций; такое ограничение нужно сохранить в документации, а не называть полной функциональной совместимостью.
- Deferred stream без доказанного final seal, UNKNOWN после неоднозначного effect, запрет старому writer и отказ unsafe rollback соответствуют требованию сохранять данные. Они не равны отсутствию recovery, пока доступен предусмотренный диагностический/операционный путь. Дальнейшая проверка должна подтвердить этот путь.
- OFF до qualification для batching/clone/stream/verifier — ожидаемый gate. Измеренный выигрыш PERF-09 и small-batch throughput/p95 пока не заявляются.
- Неприменённые миграции, несобранные пакеты и неустановленный verifier не считаются нарушением инструкции этапа реализации без исполнения. Это отдельная будущая приёмка.
- Нельзя переносить прежние PASS на совокупный код A–C; одновременно нельзя считать каждый непроверенный пункт доказанно неработающим.

## Следующее действие по результату анализа

Сначала закрыть R02–R05 в исходниках и согласовать описания A/C по retention. Для R01 сохранить OPEN до разрешённой диагностики, после которой определяется адресная правка. Затем повторно проверить изменённые ветви и только по отдельному указанию переходить к affected build/contract/state/native проверкам. Текущим этапом исправления и выполнение проверок не разрешаются.

Чужие status/handoff документы не переписывались; этот документ является отдельным заключением приёмки. Полный процент «готовности системы» не выводится из количества новых файлов или строк матрицы.

## Привязка замечаний к завершённой работе A–C

В 18:16:12 SHA-256 следующих файлов совпали с финальными manifests соответствующих исполнителей. Это позволяет не приписывать замечания текущей сетевой работе.

| Владелец | Файл | SHA-256 |
|---|---|---|
| A | packages/storage/src/durable-backend-executor.ts | 506731F440F56D8571DC22AB605FA10E26CC35FA912EE281C29732CAE4D04EDD |
| A | packages/file-core/src/file.service.ts | 1754735883F2B134AD681F4B4B9A557F5253C36FF2BAE359BB7422D9B9FFCA56 |
| A | packages/sync/src/guarded-runtime.ts | 63B8658C8C3CF9AAAD1B39EFDF523741D5D904122C5DEEA7B773FEAD4DBA0CEE |
| A | packages/contracts/src/sync-extensions.ts | 0E2D337DC5EC5E3BA7553153D1C35488BBE33A2411C5BDDE31F697A0730FBA21 |
| B | src/Neptune.Windows/App.xaml.cs | CD9AA93B47DF1F6803BFBAA8B7B43FE858835B0223CC3F8F1549872B5841C632 |
| B | src/Neptune.Windows/WindowsUpdateTransaction.cs | AE613F1973744655821613490F97C964EC57902A05CC2A8A3808988CC68B13C1 |
| C | pluto/internal/syncproto/name_codec.go | 0D2E36C9F5BE4DD52D244CF13D06480629F264B5DACAC6306A3A0DFEFD9CC6D7 |

Manifests: A — `.history/2026-10-14-parallel-saturn-baseline/implementation-files.json`; B — `.audit/2026-10-14/chat-b-neptune/current-changes.json`; C — `.audit/2026-10-14/chat-c-baseline/final-owned-changes.json`.
