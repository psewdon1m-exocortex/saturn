# Конкретный перечень оставшихся изменений Neptune / Saturn / Pluto

Дата: **2026-10-14**, часовой пояс **Europe/Istanbul, UTC+03:00**.

Статус: **этап 2 завершён — подготовлены три параллельных задания; реализация не начата**. Первый этап инвентаризации завершён. По следующему указанию оператора документ дополнен тремя заданиями с границами ответственности, владением файлами и порядком интеграции. Сейчас разрешены только чтение, документация и журнал; код, сборки и тесты не запускаются. Чаты оператор запускает самостоятельно по заданиям из раздела 6.

## 1. Вывод и границы

Оставшаяся задача шире нескольких исправлений после тестов. Постоянное состояние, основной guarded upload, snapshot/feed, значительная часть пакетной передачи и общий Windows payload уже существуют. Требуется подключение готовых механизмов к обычным сервисам, завершение namespace-операций и миграции, несколько новых оптимизированных путей и устранение последнего незавершённого восстановления Neptune.

Выделены **23 пакета изменений C01–C23**: **20 основных C01–C20**, включая диагностический C01, и **3 выбранных направления PERF-09 C21–C23**. Это пакеты работ, не количество файлов или коммитов. Ещё **3 условных расширения O01–O03** описаны отдельно и не входят автоматически в ближайшую реализацию.

**Распределение для запуска:** CHAT-A — Saturn и общие контракты; CHAT-B — Neptune; CHAT-C — Pluto и отдельный storage-verifier. Подробные границы, полное покрытие C01–C23 и готовые стартовые задания находятся в **разделе 6**, границы реализации и открытые вопросы — в **разделе 7**. Третий чат получает изолированную часть PERF-09, чтобы не оставить основной серверный объём на одном исполнителе.

Ускорение процесса: реализовывать связанные изменения блоками; не повторять полный pipeline после каждой небольшой правки. Проверки, сборка финальных пакетов и приёмка образуют следующий самостоятельный этап. В текущей инвентаризации не выполняются даже сборка, typecheck и запуск диагностического стенда.

**Шестичасовой прогон запрещён до нового явного указания оператора.** Подготовка списка, последующая реализация или разрешение обычных тестов не являются таким указанием. Production deployment, публикация release, установка агента на хранилище и возобновление пользовательского mapping не входят в этот этап.

### Источники и приоритет сведений

- [Исходный handoff с поздними дополнениями](C:/.projects/exocortex/saturn/docs/implementation/IMPLEMENTATION_HANDOFF_2026-10-13.md).
- [Implementation plan PERF-00–PERF-11](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_IMPLEMENTATION_PLAN_v1.0.md).
- [Спецификация S01–S14 / T01–T20](C:/.projects/exocortex/saturn/docs/NEPTUNE_SATURN_SYNC_PERFORMANCE_SPEC_v1.0.md).
- [Матрица последующей приёмки](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_ACCEPTANCE_MATRIX.md).
- [Журнал, включая реконструкцию пропуска и анализ длительности](C:/.projects/exocortex/.history/2026-10-13-sync-implementation-revalidation.md).

Для наличия реализации приоритет имеют текущие точки вызова и поздние дополнения handoff. Например, старое утверждение «small-file product path отсутствует» уже не соответствует текущему коду. Прежние PASS относятся к указанным в evidence версиям, а не автоматически ко всему сегодняшнему дереву или будущим правкам.

## 2. Что сохраняем и не разрабатываем заново

| Уже существующая часть | Граница оставшейся работы |
|---|---|
| Neptune SQLite, L/B/R, dirty generations, original operations, bounded scanner, resume, USN и parent reconciliation | Завершить обычную событийную оркестрацию, namespace и текущий recovery; сохранить исходные IDs, receipts и g+1 |
| JournalGap replacement, сохранение старых scopes/результатов, исправление USN-амплификации при закрытии SQLite pool | Не повторять эти исправления; новый timeout рассматривать отдельно |
| Windows guarded mapping session и eligibility bridge | Bridge существует; не считать его отсутствующим из-за старой строки handoff. Доработки — события, статусы, возможности и миграция |
| Common Windows publish → MSI и ZIP, bundle manifest/validators | Не строить две кодовые базы. Добавить полноценное обновление; финальная пересборка/установка — последующая валидация |
| Saturn operation registry, root clock, coherent snapshot/feed, upload CAS, readback и guarded runtime | Расширить coverage и координацию; не заменять работающий protocol foundation |
| Offline repair 0059 и bounded folder repair 0060 | Эти инструменты уже реализованы; нужен общий эксплуатационный путь, а не повтор той же миграции |
| Saturn small-batch registry/HTTP и Neptune native aggregates/per-file receipts | Доработать обычное включение и missing-only recovery Neptune; экономический gate ещё открыт |
| Pluto indexed engine, SQLite, protected spool, batch dispatcher, subset recovery, native lifecycle/CLI restart | Подключить к daemon и добавить Linux dirty pipeline; эти компоненты не писать заново |
| Saturn IntegrityScrubService | Курсор и ограничение партии уже есть; нужны общие IO budgets и корректная работа с guarded roots |

Последние сохранённые квалификации: Neptune Core `2bd26c63…`, cohort `48f42ca6-6aed-4497-942e-d3c833d64625`, 1154 full / 128 targeted PASS; Pluto cohort `ffa83bf1-23bb-49fd-9aea-42d5707b83ef`, 299 full race PASS с 11 существующими skips. Это исторические результаты, не тесты текущего этапа. Последующий actual restart Neptune завершился FAIL; он не отменяется приведёнными PASS.

## 3. Подтверждённые пробелы и диагностические гипотезы

| Наблюдение | Классификация | Работа |
|---|---|---|
| Pluto `Service.startLocked` вызывает `Copy`; `CopyIndexed` выделен в explicit isolated CLI | Подтверждённая незавершённая интеграция | C02–C03 |
| Neptune parent import при переименовании сохраняет конфликт, а не исполняет guarded MOVE | Подтверждённое ограничение нового контура | C09–C10 |
| Windows updater требует portable directory; apply делает пофайловый `File.Copy(overwrite:true)` | Подтверждённая незавершённая реализация PERF-01 | C19 |
| Watcher хранит hints в bounded Channel; coordinator создаёт собственный USN reader; UI debounce — общий таймер 5 секунд | Подтверждённое отличие от требуемого durable/per-object/volume подхода | C04 |
| Runtime сообщает `append-only-directories/file-cas`, FIFO admission явно process-local | Подтверждённая ограниченная серверная coverage, а не доказательство обхода guards | C07–C08 |
| Capture целиком запечатывает spool до prepare upload; пустой файл также проходит upload session | Подтверждённые ограничения fast paths | C14–C15 |
| Neptune admission retry обрабатывает только 429 `admission_full`, без общего Retry-After/503 controller | Подтверждённая неполнота | C16 |
| Actual restart: 300019 ms, один `POST changes`, retained dirty/intents; позднее найдены 254933 inbox records и 252710 unresolved | Подтверждённый отказ и накопленное состояние; точное узкое место не доказано | C01 |
| Повторные parent ensure и обработка больших наборов USN могут создавать лишние обращения | Гипотезы о стоимости; нельзя объявлять конкретный SQL виновником без измерения | C01, C06, C20 |

Источники отказа: [исходный restart failure](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/batch-network/private/profile/status-restart.failure-1791947199538.json) и события R06/R20 в журнале. Наличие одного HTTP-запроса не доказывает, что всё время было потрачено сервером или сетью. В профиле сохранён `HardlinkMembershipUnresolved`; очистка inbox, увеличение timeout или создание нового профиля не считаются исправлением.

## 4. Основные изменения C01–C20

Для каждого пункта «выход по коду» означает наличие связанной реализации, миграции/совместимости и необходимых точек вызова. Он **не означает PASS**: поведение будет проверяться отдельно. Новые модули, если названы ниже, являются предложением; существующие пути приведены ссылками.

### C01. Диагностика и устранение задержки retained recovery Neptune

- **До / причина:** последний same-profile restart не завершился за 300 секунд; текущий план `Scanning/full_membership`, hardlink proof не закрыт. Причина задержки пока неизвестна.
- **Изменить:** добавить ограниченные счётчики времени и прогресса ingest/replay/frontier/native scan/hardlink verification/import/retirement, длину очередей и число SQL обращений. По установленной причине устранить повторную работу: например, повторное сканирование уже подтверждённой страницы, неиндексированный lookup или потерю сохраняемого прогресса. Эти варианты — альтернативные гипотезы, не три обязательных исправления.
- **Файлы:** [coordinator](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsLocalCoherenceCoordinator.cs), [parent coordinator](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsLocalCoherenceCoordinator.ParentReconcile.cs), [hardlink proof](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.ParentMembershipMigration.cs), [replay](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.LocalCoherenceReplay.cs), [retirement](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.LocalCoherenceRetirement.cs).
- **Зависимости:** существующая сохранённая evidence; метрики согласовать с C20. После начала реализации динамическую диагностику запускать только в разрешённой фазе проверок; сейчас её нет. Если чтения/инструментации недостаточно, исправление остаётся открытым до такой диагностики.
- **Выход по коду:** доказанная причина и адресное исправление с сохраняемым bounded progress. Исходные generations, operation IDs, receipts и hardlink uncertainty сохраняются; неизвестность не объявляется разрешённой по timeout. Сложность: **неопределённая до диагностики**.

### C02. Подключить indexed engine к обычному Pluto daemon

- **До / причина:** normal daemon использует legacy `Copy`, новый цикл доступен отдельной командой.
- **Изменить:** выделить повторно используемую сессию из CLI orchestration; добавить capability negotiation, выбор совместимого режима, открытие/продолжение durable state, recovery перед новой работой, корректное закрытие при pause/update/shutdown и смене sources. После activation не допускать скрытого возврата к несовместимому legacy writer. Привязать отчёт engine к существующему status/check-in.
- **Файлы:** [service.go](C:/.projects/exocortex/pluto/internal/pluto/service.go), [indexed_command.go](C:/.projects/exocortex/pluto/internal/pluto/indexed_command.go), [copy_indexed.go](C:/.projects/exocortex/pluto/internal/pluto/copy_indexed.go), [config.go](C:/.projects/exocortex/pluto/internal/pluto/config.go), [CLI](C:/.projects/exocortex/pluto/cmd/pluto/main.go).
- **Зависимости:** C18 для миграции существующих конфигураций; C03 для штатного delta-режима; C13 для optional batches.
- **Выход по коду:** обычный сервис вызывает новый engine для квалифицированного root, сохраняет identity/interval/limits/pause и продолжает originals. Pluto сохраняет backup semantics: удаление/отключение источника не удаляет копии, retention остаётся 10 версий. Сложность: **средняя**.

### C03. Linux inotify и постоянная очередь изменений Pluto

- **До / причина:** повтор indexed scan всё ещё может читать содержимое неизменённых файлов; нет завершённого daemon delta pipeline.
- **Изменить:** Linux adapter с установкой watches вокруг scan boundary, durable dirty generations, coalescing, rename hints, обработкой overflow, смены mount/source identity и недоступных ветвей. После cold restart/gap запускать сохраняемую постраничную metadata reconciliation; при недоказанной неизменности — адресную проверку содержимого. Observation interval планирует health/catch-up.
- **Файлы:** [syncstate](C:/.projects/exocortex/pluto/internal/pluto/syncstate), [captured_scan.go](C:/.projects/exocortex/pluto/internal/pluto/syncstate/captured_scan.go), [migration.go](C:/.projects/exocortex/pluto/internal/pluto/syncstate/migration.go), [service.go](C:/.projects/exocortex/pluto/internal/pluto/service.go). Новые модули: inotify source и dirty scheduler внутри этих пакетов.
- **Зависимости:** C02; reuse существующих SourceWitness, generations, persistent scanner и admission.
- **Выход по коду:** при непрерывном достоверном наблюдении планируется только dirty work; после gap явно сохраняется uncertainty. Size/mtime и молчание inotify не становятся универсальным доказательством одинакового содержимого. Сложность: **высокая**.

### C04. Windows: durable hints, bounded debounce, общий USN reader

- **До / причина:** hints до drain находятся в памяти, reader создаётся на coordinator; общий UI debounce не реализует quiet/max-age по объекту.
- **Изменить:** единый координатор чтения volume с подписками roots и раздельными durable cursor/ownership; быстрый bounded ingress hints с записью в dirty state и явным gap при переполнении. Debounce по объекту: quiet 750 ms, maximum age 5 s; g+1 остаётся pending после ACK g. Связать wake-up с mapping session и исключить дублирующие циклы UI; учитывать pause/resume и несколько mappings/profiles. Привилегированный helper не делать обязательным.
- **Файлы:** [watcher](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsLocalChangeWatcher.cs), [USN reader](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsUsnJournalReader.cs), [coordinator](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsLocalCoherenceCoordinator.cs), [local state](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.LocalSource.cs), [mapping session](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsGuardedMappingSession.cs), [MainWindow](C:/.projects/exocortex/neptune/src/Neptune.Windows/MainWindow.xaml.cs).
- **Зависимости:** учитывать C01; совместный ресурсный owner согласовать с C16.
- **Выход по коду:** event loop владеет подписками и сохраняет неопределённость при потере hints; health tick не инициирует whole-tree scan. Сложность: **высокая**.

### C05. Bounded long-poll серверных изменений

- **До / причина:** `ReadChangesAsync`/`reader.changes` выполняют немедленное чтение; полноценного long-poll нет.
- **Изменить:** отдельную negotiated возможность ожидания изменения root clock с deadline/cancellation и лимитом подписок. Ожидание не держит SQL transaction/connection; уведомление только будит повторное чтение durable feed. Сохранить opaque cursor semantics, expiry/gap recovery и обычный polling fallback; изменения API additive.
- **Файлы:** [HTTP](C:/.projects/exocortex/saturn/apps/api/src/guarded-sync-http.ts), [reader](C:/.projects/exocortex/saturn/packages/sync/src/sync-snapshot-read.ts), [runtime](C:/.projects/exocortex/saturn/packages/sync/src/guarded-runtime.ts), [C# transport](C:/.projects/exocortex/neptune/src/Neptune.Core/SaturnGuardedCycleTransport.cs), [Go transport](C:/.projects/exocortex/pluto/internal/pluto/syncstate/guarded_http.go).
- **Зависимости:** C02/C04 для использования в сервисах; C16 для reconnect/backoff.
- **Выход по коду:** bounded ожидание и возобновление feed с прежнего durable cursor; отсутствие уведомления не означает отсутствие изменений. Сложность: **средняя**.

### C06. Persistent parent IDs и пакетная подготовка директорий

- **До / причина:** indexed lookup и часть singleflight/cache уже есть; guarded transport выполняет individual `directories/ensure-v2`, полный batch ensure и lifecycle persistent cache не завершены.
- **Изменить:** общий per-parent singleflight; reuse подтверждённых directory IDs с ключом root/epoch/binding/policy; bounded positive/negative cache и адресная invalidation. Добавить ensure/resolve batch до 500 items / 4 MiB распакованных метаданных, local parent refs, topological dependencies и независимые per-item outcomes. Не перечислять siblings ради одного сегмента; не считать любой 409 успешным ensure.
- **Файлы:** [folder HTTP](C:/.projects/exocortex/saturn/apps/api/src/guarded-sync-folder-http.ts), [folder coordinator](C:/.projects/exocortex/saturn/packages/file-core/src/catalog-folder-v2-database.ts), [DeviceService](C:/.projects/exocortex/saturn/packages/sync/src/device.service.ts), [Neptune engine](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsFreshSyncEngine.cs), [Go folders](C:/.projects/exocortex/pluto/internal/pluto/syncstate/guarded_http_folders.go).
- **Зависимости:** существующие registry/contracts; C07 для расширяемых mutation contracts, C12 для codec invalidation.
- **Выход по коду:** родители разрешаются один раз на актуальное поколение; несовместимый batch даёт individual fallback без новых IDs для уже принятых originals. Сложность: **средняя**.

### C07. Saturn: единый guarded путь для всех штатных изменений root

- **До / причина:** текущая coverage — append-only directories/file CAS. Legacy storage fence безопасно отказывает в части операций; это не реализация полного move/delete/restore flow.
- **Изменить:** общий mutation coordinator с durable intent/status/receipt для move, metadata patch, quarantine-delete, restore и связанных copy/import операций. Направить затронутые UI/WebDAV/Drop/device, recovery, purge и protection writers через него. Перед публикацией повторно проверять ACL, expected version и namespace; catalog change/root clock/receipt фиксировать атомарно. Для операций с несколькими объектами получать весь набор guards без частичного удержания. Active receipts/temp/history не удалять по одному возрасту; явно учитывать retention и quotas. Прямые внешние записи на backend разрешать только при observation capability либо объявлять root managed-exclusive.
- **Файлы:** [file.service.ts](C:/.projects/exocortex/saturn/packages/file-core/src/file.service.ts), [catalog commit](C:/.projects/exocortex/saturn/packages/file-core/src/catalog-commit.ts), [guarded runtime](C:/.projects/exocortex/saturn/packages/sync/src/guarded-runtime.ts), [legacy fence](C:/.projects/exocortex/saturn/packages/file-core/src/legacy-storage-fence.ts), [recovery](C:/.projects/exocortex/saturn/packages/recovery/src/service.ts), [protection](C:/.projects/exocortex/saturn/packages/protection/src), [additive migrations](C:/.projects/exocortex/saturn/packages/database/migrations).
- **Зависимости:** C08 для общего executor; новые capability/schema версии, не переписывание установленных 0057–0061. Clients C09/C10/C14/C21 подключаются к этому контракту.
- **Выход по коду:** составлена и реализована таблица всех mutation callers; каждый получает общий guarded effect либо явный unsupported, без молчаливого обхода. Полную coverage можно объявить только после реализации всех требуемых callers и последующей проверки. Сложность: **высокая**.

### C08. Общий backend executor, бюджеты API/worker и безопасная смена владельца

- **До / причина:** process-local FIFO сглаживает конкуренцию одного процесса; SQL guards не равны общему IO budget или безопасному SFTP takeover.
- **Изменить:** для Basic SFTP выбрать один активный backend writer с durable очередью/claims и маршрутизацией всех эффектов из API/worker. Общие storage slots, temp/history/disk reserve и admission учитывать на backend, а не независимо в каждом процессе. При shutdown/profile switch: закрыть admission, drain/checkpoint, сохранить UNKNOWN, подтвердить прекращение старого writer/connections, затем квалифицировать нового. Подключить существующие repair primitives к recovery state machine.
- **Файлы:** [root admission](C:/.projects/exocortex/saturn/packages/file-core/src/catalog-root-admission.ts), [upload executor](C:/.projects/exocortex/saturn/packages/file-core/src/catalog-upload-transfer.ts), [runtime](C:/.projects/exocortex/saturn/packages/sync/src/guarded-runtime.ts), [storage manager](C:/.projects/exocortex/saturn/packages/storage/src/runtime-storage.manager.ts), [worker](C:/.projects/exocortex/saturn/apps/worker/src/main.ts), [database](C:/.projects/exocortex/saturn/packages/database/migrations).
- **Зависимости:** разрабатывать совместно с C07; C18 использует этот lifecycle.
- **Выход по коду:** один исполняющий writer на Basic SFTP, общий бюджет и явный handoff. Истечение SQL lease само по себе не разрешает takeover; active-active не входит в базовую реализацию. Сложность: **высокая**.

### C09. Neptune: rename/move по стабильным IDs

- **До / причина:** rename обнаруживается, но parent reconciliation оставляет конфликт.
- **Изменить:** planner создаёт durable namespace operation по подтверждённой старой и новой identity; перенос внутри root использует node ID и expected versions, учитывает parent dependencies, case-only rename и concurrent remote changes. После результата обновляет L/B/R и derived paths без загрузки содержимого потомков. Неоднозначные halves/hardlinks/type changes остаются конфликтом до достаточного proof.
- **Файлы:** [rename state](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.ParentReconcileRename.cs), [parent install](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.ParentReconcileInstall.cs), [engine](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsFreshSyncEngine.cs), [transport](C:/.projects/exocortex/neptune/src/Neptune.Core/SaturnGuardedCycleTransport.cs); новый namespace planner и additive state migration.
- **Зависимости:** C07, C12; C01/C04 должны сохранять достоверное наблюдение.
- **Выход по коду:** обычный доказанный rename исполняет MOVE; конфликт не используется как единственный поддерживаемый результат. Pluto этот MOVE capability не получает. Сложность: **высокая**.

### C10. Neptune: условные удаления и разрешение конфликтов

- **До / причина:** новый контур не завершает безопасное mirror-delete поведение; существующий legacy Mirror нельзя использовать вместо нового proof.
- **Изменить:** планировать DELETE только для baseline-managed объекта с доказанным локальным отсутствием; postorder, expected-version CAS, quarantine/history. Массовое удаление требует plan ID/digest и подтверждения именно этой версии плана; при изменении входов approval устаревает. В UI дать preview причин, конфликтов и действий, сохранять решение/результат операции. UNKNOWN, inaccessible/incomplete scope, отключённый root или exclude не дают delete authority.
- **Файлы:** [parent install/missing](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.ParentReconcileInstall.cs), [cycle work](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.LocalCycleWork.cs), [MainWindow](C:/.projects/exocortex/neptune/src/Neptune.Windows/MainWindow.xaml.cs), [WindowsSyncService](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsSyncService.cs); серверная часть C07.
- **Зависимости:** C07/C09/C11/C12; для пользовательских решений — C20.
- **Выход по коду:** plan → approval при необходимости → guarded execution → durable outcome. Pluto deletion/source removal сохраняет копии и не вызывает этот путь. Сложность: **высокая**.

### C11. Versioned excludes и план изменения области синхронизации

- **До / причина:** нет завершённой версии policy с безопасным переходом для уже managed объектов.
- **Изменить:** хранить policy version/hash в mapping/source state, вычислять preview affected scope, при изменении правил инвалидировать только нужные планы/кеши. Исключение уже управляемой области оставляет серверные данные. Явно обрабатывать расширение/сужение источников и несогласованные originals. Не вводить скрытых исключений `.git`, `node_modules`, `.audit`.
- **Файлы:** [Windows preferences](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsPreferencesStore.cs), [Neptune state](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.LocalCycle.cs), [Pluto config](C:/.projects/exocortex/pluto/internal/pluto/config.go), [Pluto migration](C:/.projects/exocortex/pluto/internal/pluto/syncstate/migration.go), policy contracts и UI/CLI preview.
- **Зависимости:** C12 для одинаковой интерпретации имён; C18 для изменения существующих mappings.
- **Выход по коду:** версия policy входит в durable binding/план; preview объясняет последствия, изменение policy не превращается в массовое удаление. Сложность: **средняя**.

### C12. Версионированный NameCodec и namespace migration

- **До / причина:** strict wire/name validation и Unicode foundations есть; полный управляемый переход codec/collision policy отсутствует.
- **Изменить:** закрепить codec в root/mapping binding, использовать одну спецификацию C#/Go/TS; подготовить collision dry-run и сохраняемый план перехода. Старый root сохраняет legacy names/semantics. `portable_v1` включается отдельно после принятия плана; разрешить case-only transitions с guarded sequencing. Root identity, remount/overlap, symlink/junction/hardlink boundaries сохранить как ограничения, а не нормализовать молча.
- **Файлы:** [TS contracts](C:/.projects/exocortex/saturn/packages/contracts/src/sync-protocol.ts), [C# protocol](C:/.projects/exocortex/neptune/src/Neptune.Core/Sync/Protocol), [Go protocol](C:/.projects/exocortex/pluto/internal/syncproto), [current namespace](C:/.projects/exocortex/saturn/packages/file-core/src/current-namespace.ts), client/server migrations.
- **Зависимости:** существующие golden contracts; C07 для исполнения миграции, C18 для operational entry point.
- **Выход по коду:** codec version явна; несовместимые/colliding names дают отчёт и отказ перехода, а не автопереименование. Подготовка новых vectors — часть будущего изменения контракта, их выполнение сейчас запрещено. Сложность: **средняя**.

### C13. Довести small batches до обычной эксплуатации

- **До / причина:** core/HTTP/spool/receipts работают; Neptune activation остаётся qualification-only, а missing-only subset recovery ещё нет. Pluto subset recovery уже есть.
- **Изменить:** добавить обычную per-root настройку negotiated batching и корректное отключение с восстановлением прежних originals. В Neptune после batch status собирать bounded subset только из достоверно не принятых элементов; accepted partial uploads продолжать по исходным individual operations. Не менять membership старого batch, idempotency keys или ранее принятые upload IDs; новый aggregate содержит ссылки на originals. Подключить существующий Pluto режим через C02.
- **Файлы:** [Neptune batches](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsFreshSyncEngine.SmallBatches.cs), [batch recovery state](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.SmallBatchRecovery.cs), [mapping session](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsGuardedMappingSession.cs), [Pluto dispatcher](C:/.projects/exocortex/pluto/internal/pluto/syncstate/small_batch_dispatch.go), [Pluto config](C:/.projects/exocortex/pluto/internal/pluto/config.go).
- **Зависимости:** C02/C16/C18; reuse существующих 500 items/32 MiB/age limits и private artifacts.
- **Выход по коду:** production wiring и recoverable flag lifecycle готовы; автоматическое включение остаётся OFF до отдельного benefit gate ≥15% throughput, p95 не хуже более чем на 20%. Сложность: **средняя**.

### C14. Create-empty и доказанный metadata-only path

- **До / причина:** нулевой размер поддерживается upload executor, но всё ещё создаёт upload session. Полного metadata-only command path нет.
- **Изменить:** batch mutation `create-empty` с обычными expected/receipts, без отдельного transport upload; metadata patch только при доказанной неизменности content/version. Использовать те же authority, namespace guards, журнал и историю; сохранять old upload fallback по capability.
- **Файлы:** [contracts](C:/.projects/exocortex/saturn/packages/contracts/src/sync-protocol.ts), [file-core](C:/.projects/exocortex/saturn/packages/file-core/src), [Neptune engine](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsFreshSyncEngine.cs), [Pluto executor](C:/.projects/exocortex/pluto/internal/pluto/syncstate/captured_executor.go).
- **Зависимости:** C07; batching метаданных согласовать с C06.
- **Выход по коду:** empty/metadata-only операции имеют durable результат без фиктивной передачи содержимого; совпадения mtime недостаточно для metadata-only. Сложность: **средняя**.

### C15. Большие файлы: отправка chunks до whole-file seal

- **До / причина:** стабильный source уже читается один раз при capture, но upload начинается после полного spool/hash. Это ограничивает latency, перекрытие IO и размер файла бюджетом полного spool.
- **Изменить:** additive capability/protocol для immutable operation identity до whole SHA, bounded chunk spool, chunk SHA/ACK map, whole SHA в процессе чтения и final seal. Начинать отправку готовых chunks раньше завершения чтения; сервер публикует только после seal, backend verification и namespace CAS. При restart подтверждённые chunks не отправлять повторно без причины; недостающие bytes получать только из той же доказанной версии источника либо сохранять операцию deferred. Частичный digest после restart нельзя восстановить из конкатенации chunk hashes; отдельное восстановительное чтение явно учитывать.
- **Файлы:** [capture](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsNativeCycleCapture.cs), [engine](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsFreshSyncEngine.cs), [resources](C:/.projects/exocortex/neptune/src/Neptune.Core/LocalCycleResources.cs), [Go stream](C:/.projects/exocortex/pluto/internal/pluto/syncstate/captured_stream.go), [upload intent](C:/.projects/exocortex/saturn/packages/file-core/src/catalog-upload-intent.ts), [upload transfer](C:/.projects/exocortex/saturn/packages/file-core/src/catalog-upload-transfer.ts), соответствующие transports/state/contracts.
- **Зависимости:** C08/C16; новые intent версии не меняют уже запечатанные originals. Pluto сохраняет свой лимит 256 MiB.
- **Выход по коду:** реальный early-streaming путь плюс совместимый старый sealed-spool fallback; source mutation имеет явный deferred/uncertain outcome. Сложность: **высокая**.

### C16. Operation retry и адаптивный scheduler с общими бюджетами

- **До / причина:** фиксированные budgets/backpressure есть; общий controller полезной скорости и classified retry неполны.
- **Изменить:** сохраняемые RETRY_WAIT, SOURCE_BUSY, WAIT_CONNECTIVITY/DEGRADED; reset/timeout/408/429/временные 5xx обрабатываются для конкретной операции. После неоднозначного ответа сначала original status. Jitter `random(0,min(60s,1s*2^attempt))`, Retry-After как нижняя граница; после 8 неуспехов редкая проверка, без reset root. Scheduler разделяет source reader/CPU/buffers/spool/network/backend; fair byte scheduling live/bootstrap/recovery с aging и заимствованием свободной доли. Адаптация опирается на published throughput, latency и pool wait, сохраняет пользовательские bandwidth limits и cooldown.
- **Файлы:** [Neptune engine](C:/.projects/exocortex/neptune/src/Neptune.Core/WindowsFreshSyncEngine.cs), [resources](C:/.projects/exocortex/neptune/src/Neptune.Core/LocalCycleResources.cs), [Go executor](C:/.projects/exocortex/pluto/internal/pluto/syncstate/captured_executor.go), [Go HTTP](C:/.projects/exocortex/pluto/internal/pluto/syncstate/guarded_http.go), [server admission](C:/.projects/exocortex/saturn/packages/file-core/src/catalog-root-admission.ts), [SFTP pool](C:/.projects/exocortex/saturn/packages/storage/src/sftp-pool.ts).
- **Зависимости:** C08/C20; общий клиентский budget не размножается на mapping. Neptune/server ceilings из PERF-05 соблюдать; существующие более строгие ограничения Pluto не повышать автоматически.
- **Выход по коду:** единый классификатор причин и controller; увеличение concurrency не обходится увеличением RAM/temp. SFTP window tuning делать только после измерения — конкретное увеличение window сейчас не предписывается. Сложность: **высокая**.

### C17. Negotiated gzip для метаданных

- **До / причина:** полноценного согласованного compressed metadata path нет.
- **Изменить:** capability и Content-Encoding для метаданных >16 KiB, bounded потоковая распаковка; ограничивать и compressed bytes, и uncompressed bytes/depth/item count. Проверять исходный canonical intent независимо от wire encoding, поддержать отключение/fallback. Сжатие содержимого файлов по умолчанию не включать.
- **Файлы:** [guarded HTTP](C:/.projects/exocortex/saturn/apps/api/src/guarded-sync-http.ts), [batch HTTP](C:/.projects/exocortex/saturn/apps/api/src/guarded-sync-small-batch-http.ts), [C# transport](C:/.projects/exocortex/neptune/src/Neptune.Core/SaturnGuardedCycleTransport.cs), [Go transport](C:/.projects/exocortex/pluto/internal/pluto/syncstate/guarded_http.go), capability contracts.
- **Зависимости:** C06/C13 формируют крупные metadata payload; C16 ограничивает CPU/буферы.
- **Выход по коду:** compression не меняет смысл подписанного/хешированного intent и не обходит limits. Включение в эксплуатации — после отдельной оценки эффекта. Сложность: **низкая–средняя**.

### C18. Эксплуатационная миграция и управление существующими профилями

- **До / причина:** отдельные schema migrations, repairs и CLI существуют; общий поддерживаемый путь populated-root activation/adoption/rollback не завершён.
- **Изменить:** orchestration «Saturn additive API/schema → совместимые клиентские packages → plan/adopt → per-root activation». Добавить реально работающие inspect/pause/checkpoint/backup/migrate-plan/adopt/resume/diagnostics, используя готовые primitives. План фиксирует old/new bindings, compatibility, UNKNOWN и активные originals; apply повторяем и имеет progress journal. Старый writer после activation получает явный отказ. Backup SQLite учитывает WAL; несовместимые partial uploads остаются quarantined, originals не пересоздаются. Feature rollback сохраняет новый индекс; binary rollback проверяет schema/receipts/new publications.
- **Файлы:** [Pluto CLI](C:/.projects/exocortex/pluto/cmd/pluto/main.go), [Windows entry](C:/.projects/exocortex/neptune/src/Neptune.Windows/App.xaml.cs), [Windows profile](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsProfileContext.cs), [Saturn revalidation CLI](C:/.projects/exocortex/saturn/scripts/revalidate-guarded-folders.mts), [runtime manifest](C:/.projects/exocortex/saturn/packages/sync/src/guarded-runtime-manifest.ts), state/migrations обоих клиентов.
- **Зависимости:** базовые C07/C08; конкретные новые schemas/features подключаются к этому lifecycle. Не требуется заново создавать 0059/0060.
- **Выход по коду:** команды выполняют настоящие действия и дают typed результат; plan-only не пишет в пользовательский root. Исходные identity/credentials/pause/schedules/limits сохраняются. Сложность: **высокая**.

### C19. Полноценное installed/portable обновление Windows

- **До / причина:** упаковки уже общие, но updater принимает portable v1 и не имеет установленного MSI transaction/health rollback path.
- **Изменить:** выбор package variant из signed bundle с compatibility bounds, сохранив чтение переходного portable manifest. Installed mode использует поддерживаемую installer transaction; portable — staged replacement с recoverable журналом, а не незавершённый пофайловый overwrite единственной рабочей копии. Перед apply — pause/drain/checkpoint и проверка владельцев профилей; предыдущий payload сохранять до health check. После failure — совместимое восстановление, сохранение pause/identity/autostart и выбранного профиля. Подпись ОС установщика проверяется отдельно от подписи manifest.
- **Файлы:** [WindowsUpdateService](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsUpdateService.cs), [UpdateApplyMode](C:/.projects/exocortex/neptune/src/Neptune.Windows/UpdateApplyMode.cs), [packaging policy](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsPackagingPolicy.cs), [MainWindow](C:/.projects/exocortex/neptune/src/Neptune.Windows/MainWindow.xaml.cs), [release workflow](C:/.projects/exocortex/neptune/.github/workflows/release.yml), [packaging scripts](C:/.projects/exocortex/neptune/scripts).
- **Зависимости:** C18; существующий common payload pipeline переиспользуется.
- **Выход по коду:** обе упаковки имеют собственный корректный apply path и общий профиль/engine. Native installation, OS trust и окончательная сборка — будущая приёмка, не основание ослаблять release gates. Сложность: **высокая**.

### C20. Единые диагностические счётчики и понятный mapping status

- **До / причина:** raw counters/typed errors есть; UI в основном показывает общий текст «Uploading», полного per-phase состояния нет.
- **Изменить:** модель queued/captured/received/written/verified/published, oldest pending, source/journal lag, retries, источник ожидания, SQL/SFTP/pool wait и resource pressure. Отображать статус конкретного mapping/source; не объявлять received bytes опубликованными. Для C01 добавить bounded phase timing без путей в metric labels. Diagnostic export исключает credentials и содержимое файлов.
- **Файлы:** [cycle models](C:/.projects/exocortex/neptune/src/Neptune.Core/LocalCycleModels.cs), [Windows service](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsSyncService.cs), [MainWindow](C:/.projects/exocortex/neptune/src/Neptune.Windows/MainWindow.xaml.cs), [Pluto service/status](C:/.projects/exocortex/pluto/internal/pluto/service.go), [Saturn runtime](C:/.projects/exocortex/saturn/packages/sync/src/guarded-runtime.ts).
- **Зависимости:** поля добавлять вместе с C01/C02/C08/C16, UI завершать после стабилизации state model.
- **Выход по коду:** причины задержки видны без повторного полного тестового pipeline; служебные детали не перегружают обычный экран. Сложность: **средняя**.

## 5. Выбранные ускорения PERF-09

Выбор основан на устраняемой работе, а не на обещании определённого процента скорости. Замеры ещё не выполнены. Реализация capability и её эксплуатационное включение — разные шаги: без подтверждения возможностей backend feature остаётся OFF.

### C21. Authorized clone/content reuse — включить в реализацию

- **До / причина:** известные одинаковые bytes не используются через полноценную авторизованную sync-команду. `StorageAdapter.copy` есть, но SFTP реализация прокачивает bytes через Saturn.
- **Изменить:** bounded lookup `(authorization_scope,size,sha256)` и versioned content reference; `clone-content` с проверкой прав/immutable source version/expected destination/quota. Поддержать независимую физическую копию или подтверждённый backend clone, обычные publication guards/history/receipt и fallback upload. Клиент предлагает только уже достоверно известный hash; не читать всё дерево заранее ради dedupe.
- **Файлы:** [StorageAdapter](C:/.projects/exocortex/saturn/packages/storage/src/types.ts), [local adapter](C:/.projects/exocortex/saturn/packages/storage/src/local-storage.adapter.ts), [SFTP adapter](C:/.projects/exocortex/saturn/packages/storage/src/sftp-storage.adapter.ts), [file-core](C:/.projects/exocortex/saturn/packages/file-core/src), [contracts](C:/.projects/exocortex/saturn/packages/contracts/src/sync-protocol.ts), planners обоих клиентов.
- **Зависимости:** C07/C08/C12; C22 даёт наиболее выгодный remote-local backend path. Не нужны Merkle или block delta.
- **Выход по коду:** нет cross-user existence oracle, mutable hardlinks и ссылки на изменившийся source path. При известном дубликате размера S потенциально устраняется S bytes клиентского upload; экономия на участке Saturn↔storage зависит от реального copy capability. Сложность: **средняя–высокая**.

### C22. Storage-local verification — включить capability и рабочую реализацию

- **До / причина:** upload executor читает backend temp для SHA-256; при замене дополнительно читает preimage. На SFTP это сетевой readback, даже если файл уже лежит на конечном диске.
- **Изменить:** typed verification contract, связанный с backend identity, immutable operation/version, length/hash и фактическим уровнем durability. Реализовать локальный backend verifier; для удалённого диска — отдельный optional host-side verifier/agent с аутентификацией, ограниченной областью путей, no-follow, owner/fencing проверкой и ответом, привязанным к конкретному intent. Подключить его в общий executor; отказ/неподдержка возвращают readback fallback, а не пропуск проверки. Для параллельной работы host-side модуль закреплён за отдельным storage-verifier package и CHAT-C; детали интерфейса K4 согласует CHAT-A. Установка сейчас не предполагается.
- **Файлы:** [storage types](C:/.projects/exocortex/saturn/packages/storage/src/types.ts), [local adapter](C:/.projects/exocortex/saturn/packages/storage/src/local-storage.adapter.ts), [SFTP adapter](C:/.projects/exocortex/saturn/packages/storage/src/sftp-storage.adapter.ts), [upload transfer](C:/.projects/exocortex/saturn/packages/file-core/src/catalog-upload-transfer.ts), [runtime manifest](C:/.projects/exocortex/saturn/packages/sync/src/guarded-runtime-manifest.ts), новый verifier protocol/host-side module. В распределении этапа 2 CHAT-A владеет контрактом, adapters и integration; CHAT-C — отдельным новым пакетом `C:/.projects/exocortex/saturn/packages/storage-verifier/`. Пакет сейчас не создаётся; его реализация не означает разрешения установки на remote host.
- **Зависимости:** C08; доступность установки у конечного диска — внешний gate включения. Не предполагать, что произвольный SFTP сервер разрешает shell/checksum/расширения.
- **Выход по коду:** конкретный работающий verifier и fallback, а не capability stub. Для нового файла S можно убрать примерно S bytes обратного readback по сети storage→Saturn; локальное чтение диска сохраняется. Durability/fencing нельзя вывести только из совпадения SHA. Сложность: **высокая**, эксплуатационный эффект зависит от backend.

### C23. Подключить существующий scrub к общему бюджету и guards

- **До / причина:** `IntegrityScrubService` уже имеет persistent cursor, locks и лимит партии, но не общий IO controller нового executor. Первый крупный объект может превышать nominal batch byte budget; corruption path напрямую меняет catalog status.
- **Изменить:** reuse cursor/итератор, добавить cooperative byte/time budget, cancellation/progress и низкоприоритетную долю IO. Quarantine/change notification проводить через C07, чтобы изменения availability попадали в согласованный журнал. Новые upload/recovery не должны голодать за scrub. Локальный verifier C22 применять только с сохранением отдельного смысла независимой физической проверки.
- **Файлы:** [IntegrityScrubService](C:/.projects/exocortex/saturn/packages/protection/src/integrity-scrub.service.ts), [worker](C:/.projects/exocortex/saturn/apps/worker/src/main.ts), общий admission/executor C08/C16.
- **Зависимости:** C07/C08/C16. Это интеграция готового механизма, не новый full-scan engine.
- **Выход по коду:** scrub имеет собственный progress/бюджет и не скрывает физическую порчу из-за совпадения метаданных. Эффект — снижение конкуренции за IO и latency spikes; ускорение каждого upload не обещается. Сложность: **средняя**.

### Условные расширения: не включать автоматически

| ID | Решение | Когда оправдано | Причина условности и конкретный объём |
|---|---|---|---|
| O01 | Fixed-block delta ≥256 MiB | Есть immutable base, backend-side block reuse/assembly, missing ≤25%, прогноз полной стоимости лучше whole-file минимум на 20% | После C15/C22: 1 MiB blocks, bounded manifest, chunk/base identity, assembly, whole verification и poor-match fallback. Без измеренных скоростей выбирать whole-file. Для текущего small-file D1 пользы почти нет; лимит Pluto 256 MiB не повышать |
| O02 | Merkle metadata reconciliation | Большие индексы и дорогие feed-gap recovery, при которых snapshot paging действительно доминирует | После C07/C18: stable buckets, canonical format/epoch, обновление summaries и сравнение на общем cut. Не ускоряет автоматически local USN hardlink backlog C01, не заменяет feed/scrub |
| O03 | Application export / VSS | Есть конкретные активные БД/VM, требующие групповой согласованности | Explicit source profile, export/snapshot lifecycle, writer consistency, TTL/space/cleanup. Не останавливать приложения автоматически. Это функция корректности выбранного workload, а не универсальное ускорение; обычный busy-source defer остаётся |

Эти три возможности остаются видимым остатком PERF-09, а не «выполненными» пунктами. Их отсутствие при OFF и корректном fallback не блокирует базовый выпуск по implementation plan. Решение о включении принимать по workload/capability и стоимости; результаты таких проверок пока отсутствуют.

## 6. Три параллельных задания

Этот раздел **заменяет прежний последовательный порядок A–H**. C01–C23 сохраняют содержание; сквозные пункты разделены по компонентам, а не отданы целиком нескольким чатам. Распределение не запускает чаты и не разрешает реализацию в текущем разговоре: ниже приведены задания, которые оператор может передать трём отдельным чатам.

### 6.1. Задание CHAT-A — Saturn: контракты, executor, публикация и интеграция

CHAT-A — владелец общего wire-контракта и интеграционного реестра; он не становится исполнителем всего клиентского кода.

- **Полностью в своей области:** C07, C08, C23; все серверные части C05/C06/C11–C18/C20–C22. Серверные MOVE/delete primitives из C07 обслуживают C09/C10, но Windows planner/UI остаются у CHAT-B.
- **Реализовать:** versioned contracts/capabilities, folder/mutation/empty/metadata/clone commands; общий backend writer, SQL guards/receipts/retention, coordination и recovery; feed long-poll, final-seal protocol, server budgets/gzip; populated-root activation/CLI; verifier client/adapters/local backend implementation и scrub integration.
- **Исключительное владение:** `C:/.projects/exocortex/saturn/` **кроме** нового `packages/storage-verifier/`, принадлежащего CHAT-C, и его личных handoff/journal файлов. В частности, только CHAT-A меняет contracts/fixtures/schema, database migrations, storage adapters, file-core, API/worker, root package manifest/lockfile, workspace/CI integration и общий implementation-документ после старта трёх чатов.
- **Первое действие реализации:** выдать минимальные согласованные контракты K1–K4 из раздела 6.5 до завершения серверных реализаций. Пока другие выполняют независимые части, закрыть структуру requests/results/errors/versions, чтобы они не угадывали wire format.
- **Получить от соседей:** список реально используемых client fields и capability requirements; от CHAT-C — готовый host-side verifier, package dependency request и ограничения платформы. Самому выполнить его root workspace/lockfile wiring в своей области, когда соответствующие операции будут разрешены.
- **Передать:** серверную реализацию согласованных endpoint/capability версий, compatibility/migration notes, список unsupported внешних capabilities и открытых validation gates. Приёмка реализации — по исходным C-критериям, не по наличию заглушек.
- **Независимая работа при ожидании:** C07/C08 lifecycle, additive migrations, scrub budget, operational migration. Нельзя править Neptune/Pluto или host-side package вместо их владельцев.

### 6.2. Задание CHAT-B — Neptune: Windows engine, namespace, transport и updater

CHAT-B — владелец Neptune. Причина C01 остаётся открытым диагностическим вопросом.

- **Полностью в своей области:** C01, C04, C09, C10, C19; C# / Windows части C05/C06/C11–C18/C20/C21. Серверные реализации этих пунктов выполняет CHAT-A.
- **Реализовать:** bounded recovery instrumentation и доказанное исправление; durable events/volume ownership/debounce; move/delete/conflicts/excludes/codec; parent reuse и batches/subset recovery; empty/meta-only, streaming/seal, classified retry/budgets/gzip, clone caller; profile migration/CLI, installed/portable updater и mapping status.
- **Исключительное владение:** весь `C:/.projects/exocortex/neptune/`, включая C# contracts, Core/state migrations, Windows UI/transport, installer/updater, собственные scripts/release metadata. Общий TS/JSON wire schema в Saturn принадлежит CHAT-A.
- **Первое действие реализации:** начать C01/C04 и updater/profile lifecycle, не ожидая завершения Saturn. Из существующих спецификаций извлечь требования клиента к K1–K4; нестабильные endpoint names/fields не закреплять самостоятельно.
- **Получить от CHAT-A:** версионированные K1–K4 и capability/error semantics. По ним реализовать production transport и planner; сервер не обязан быть уже запущен. Общие canonical vectors читает, C# представление адаптирует в своём репозитории.
- **Передать:** связанную реализацию Windows-клиента, перечень используемых contract revisions, schema/update compatibility и оставшиеся gates. Если причина C01 требует запрещённой сейчас динамической диагностики, статус C01 остаётся открытым с конкретной причиной; независимую работу продолжить.
- **Независимая работа при ожидании:** local state/ownership, debounce, preview/conflict UI, packaging updater. Исправление C01 не подменять очисткой профиля, ростом timeout или пропуском hardlink proof.

### 6.3. Задание CHAT-C — Pluto и отдельный verifier у конечного диска

CHAT-C — владелец Pluto и отдельного host-side модуля C22.

- **Полностью в своей области:** C02/C03; Go-части C05/C06/C11–C18/C20/C21; host-side часть C22. C09/C10 MOVE/DELETE не переносить в Pluto — backup semantics сохраняются.
- **Реализовать в Pluto:** normal daemon indexed session, Linux inotify/dirty queue/recovery, policy/codec/config migration, transport новых metadata/streaming/retry/clone возможностей и status/CLI. Существующие batch dispatcher/subset/native spool переиспользуются.
- **Реализовать отдельный verifier:** новый изолированный TypeScript-пакет `C:/.projects/exocortex/saturn/packages/storage-verifier/`, согласованный с принятым в Saturn runtime. Внутри — host-side entry point, ограниченная root/path authority, authentication, immutable intent/version binding, no-follow, owner/fencing checks, bounded read/hash и явный durability result, cancellation/limits и package-local эксплуатационная документация. Это самостоятельный capability-компонент, не изменение роли Pluto daemon. Никакой установки/запуска на внешнем host в задании нет.
- **Исключительное владение:** весь `C:/.projects/exocortex/pluto/` и только новый `saturn/packages/storage-verifier/` внутри Saturn, включая его package-local manifest/config. Не менять существующие `saturn/packages/storage/`, `file-core/`, `contracts/`, root lockfile/workspace/CI — передавать требования CHAT-A. Общий verifier protocol принадлежит CHAT-A; host module не создаёт несовместимую вторую схему.
- **Первое действие реализации:** начать C02/C03 и protected host-module skeleton/lifecycle без фиктивного включения capability. Передать CHAT-A нужные поля K4 и package dependencies; после фиксации K4 реализовать настоящий verifier, а не stub.
- **Передать:** работающий код daemon/Go callers и host module, поддерживаемые платформы/возможности, схемы состояния, limits и fallback constraints. Клиентская сторона verifier и подключение к Saturn executor остаются у CHAT-A. Если backend-side clone потребует расширения host module, оно добавляется только в рамках согласованного K4/C21, без O01 block assembly.
- **Независимая работа при ожидании:** inotify, persistent reconciliation, protected source/config lifecycle, local host verification primitives. Сохранять лимит Pluto 256 MiB и 10 версий; отсутствие источника не удаляет серверные копии.

### 6.4. Полная матрица владения C01–C23

Знак «—» означает отсутствие реализации в этом компоненте. Одинаковый C-ID в двух колонках означает разные части одного end-to-end изменения. Ни один существующий файл не имеет двух владельцев.

| Пункт | CHAT-A — Saturn | CHAT-B — Neptune | CHAT-C — Pluto/verifier |
|---|---|---|---|
| C01 | — | Диагностика и адресное исправление | — |
| C02 | — | — | Indexed engine в daemon |
| C03 | — | — | Linux events/durable dirty/reconcile |
| C04 | — | Volume reader, durable hints/debounce | — |
| C05 | Long-poll endpoint/capability | C# caller/event loop | Go caller/event loop |
| C06 | Folder batch contract/executor | Parent IDs/cache/batch caller | Parent IDs/cache/batch caller |
| C07 | Общие mutation primitives и все Saturn writers | Потребитель через C09/C10/C14 | Потребитель разрешённых backup-операций |
| C08 | Backend owner, budgets, handoff/UNKNOWN | — | — |
| C09 | MOVE primitive в C07; не дублировать | Windows rename/move planner/state | — |
| C10 | Delete/quarantine primitive в C07; не дублировать | Delete plan/approval/conflict UI | — |
| C11 | Policy version в authority/contracts | Excludes/mapping preview | Excludes/source preview |
| C12 | Canonical codec/schema/vectors/root transition | C# codec/collision/migration | Go codec/collision/migration |
| C13 | Capability/error совместимость существующих batches | Production wiring и missing-only subset | Normal service wiring готовых batches |
| C14 | Empty/metadata command и receipt | Planner/transport | Planner/transport |
| C15 | Streaming intent/chunks/final seal/publication | Source/chunk state/transport | Source/chunk state/transport |
| C16 | Server admission/fairness/retry hints | Client retry/controller/budgets | Client retry/controller/budgets |
| C17 | Negotiation/HTTP limits/gzip | C# gzip и limits | Go gzip и limits |
| C18 | Server CLI/activation/migration и общий порядок | Windows profile/state/CLI | Pluto config/state/CLI |
| C19 | — | Installed/portable updater/release scripts | — |
| C20 | Server metrics, единые semantics | Windows metrics/status/UI | Pluto metrics/status/CLI |
| C21 | Authorized lookup/clone/executor/adapter | Known-hash planner/clone caller | Known-hash Go caller; host primitive только по K4 |
| C22 | Protocol/client/adapters/local verifier/integration | — | Отдельный host-side verifier package |
| C23 | Существующий scrub + общий budget/guards | — | — |

O01–O03 остаются условными и **не распределяются как обязательная реализация**. Coverage исходных этапов из раздела 8 сохраняется.

### 6.5. Общие контракты и ранние передачи

В начале реализации CHAT-A создаёт `C:/.projects/exocortex/saturn/docs/implementation/PARALLEL_SYNC_CONTRACTS_2026-10-14.md`. Файл сейчас не создаётся: wire-решения должны опираться на разбор implementation. У каждой группы контракта есть revision, DRAFT/READY и перечень принимающих чатов. READY означает согласованность интерфейса для кодирования, а не работоспособность/проверенность реализации.

| Контракт | Минимальное содержимое | Владелец / потребитель | Что разблокирует |
|---|---|---|---|
| K1 — metadata/namespace | root/binding/epoch/policy/codec, request/result/error, expected/CAS, operation/receipt identity, limits, folder refs, MOVE/delete/empty/metadata/clone и fallback | A → B/C; Pluto MOVE/delete не разрешать | C06/C09–C14/C21 |
| K2 — data transfer | prepare до whole hash, chunk identity/ACK/resume, final seal, source generation, terminal/UNKNOWN states, compatibility старых originals | A → B/C | C15; согласование с C13/C16 |
| K3 — lifecycle/events | capabilities/activation/min writer, cursor/long-poll, Retry-After/errors, pause/checkpoint/recovery, status/metrics semantics | A → B/C | C02/C05/C16–C18/C20 |
| K4 — storage verifier | backend/root/operation/version identity, scoped authorization, ownership/fencing, read limits/cancellation, hash/length/durability, error/fallback; согласованный encoding и interface | A ↔ C; schema owner A, host implementation C | C22 и возможный backend clone C21 |

Порядок A: сначала **минимальные K1/K3/K4**, затем **K2** до перехода клиентов к C15. Не ждать завершения всех endpoints для выдачи READY. B/C отмечают в личных status-файлах принятую revision либо конкретное несовпадение с существующим state/transport. CHAT-A читает эти замечания и исправляет единственный общий contract; не требуется отдельное разрешение оператора на каждое обычное техническое уточнение.

Изменение READY-контракта имеет новую revision и список затронутых callers. Старую revision не переписывать незаметно. Пока нужная группа DRAFT, исполнитель делает независимую часть, но не выдаёт временный stub за завершённый путь. Runtime activation feature остаётся OFF до последующей квалификации. HTTP/API ошибки и client state должны следовать общим semantics, даже если продукты реализуются параллельно.

### 6.6. Работа в общей папке без конфликтующих правок

1. Исходная рабочая область — **текущее dirty дерево**, не чистый HEAD. Перед первыми правками каждый сохраняет перечень/хеши своих файлов и сведения о старых изменениях; не обнуляет, не stashes и не заменяет их checkout из HEAD. На этапе 2 новые worktrees/branches не создаются. Если далее будет выбран worktree, в него должна попасть согласованная исходная незакоммиченная работа, а не только HEAD.
2. При работе трёх чатов в этой же папке правило владения из 6.1–6.3 обязательно. CHAT-A исключает весь новый verifier package из своих правок. Не использовать общий `git add -A`, массовый format/generate или cleanup по чужим областям. Увиденные изменения соседнего владельца не исправлять и не откатывать.
3. PostgreSQL migrations и общие schema/fixtures/root manifests/lockfiles назначает только CHAT-A. SQLite migration versions каждого клиента назначает его единственный владелец. Package-local manifest verifier меняет CHAT-C, root dependency integration — CHAT-A. Запрос чужого изменения передаётся через личный handoff/status, а не правкой чужого файла.
4. Каждый чат создаёт собственный журнал: `C:/.projects/exocortex/.history/2026-10-14-parallel-saturn.md`, `C:/.projects/exocortex/.history/2026-10-14-parallel-neptune.md`, `C:/.projects/exocortex/.history/2026-10-14-parallel-pluto-verifier.md` соответственно. Формат каждого события: дата/время с UTC offset; причина; до/входной гейт; что/как сделано; выходной гейт и реальные результаты проверок либо «не запускались». Общий исторический журнал остаётся за текущим координирующим чатом.
5. Для передачи состояния каждый пишет только свой файл `C:/.projects/exocortex/saturn/docs/implementation/parallel-2026-10-14/CHAT-A.md`, `CHAT-B.md` или `CHAT-C.md`. Поля: время, completed/in-progress/open C-subparts, собственные changed paths, принятие K1–K4 revisions, запросы другому владельцу, blockers, tests/builds run or not run. Эти файлы и journals будут созданы при старте соответствующего задания; сейчас это зарезервированные пути. Все могут читать их; сообщение в другой чат не требуется для файлового обмена.
6. Сборки, typecheck, test suites, native reproductions, контейнеры, installs и benchmarks не запускать до отдельного указания оператора. Ни один чат не запускает свой полный pipeline после каждой правки. В частности, запрет 6h действует независимо от будущего разрешения других проверок. При нехватке диска прежнее разрешение очистки касается только ненужного Docker-объёма: сначала установить принадлежность; не удалять retained profiles/evidence или чужие active volumes. На этапе документации очистка не нужна.

### 6.7. Параллельный старт и завершение без четвёртой задачи

| Период | CHAT-A | CHAT-B | CHAT-C |
|---|---|---|---|
| Старт | Обозначает K1/K3/K4 и затем K2, начинает C07/C08 | C01/C04, updater/profile lifecycle; сообщает contract requirements | C02/C03, host package/local primitives; сообщает K4 requirements |
| Основная реализация | Server primitives/endpoints, lifecycle, adapters, scrub | Namespace/transport/streaming/scheduler по READY revision | Daemon/transport/streaming и host verifier по READY revision |
| Интеграция кода | Подключает verifier, сводит schema/capability/compatibility и общий реестр | Подключает готовые primitives к обычному Windows flow, сверяет C# callers | Подключает Go primitives к daemon, завершает package-local verifier entry point |
| Передача результата | Обновляет общий checklist C01–C23 и release/validation остаток | Публикует свой handoff, устраняет несовпадения в Neptune | Публикует свой handoff, устраняет несовпадения в Pluto/host package |

**Интеграционный владелец — CHAT-A**, но исправления в чужом коде остаются за CHAT-B/C. Каждый отвечает за собственное caller wiring, handoff и согласование; отдельная четвёртая реализационная задача не подразумевается. End-to-end и полная регрессия — следующий разрешаемый этап.

Критерий завершения пакета: собственные C-subparts реализованы и подключены к реальным production entry points; contract revisions записаны; migrations/compatibility/fallback сохранены; нет помеченных готовыми заглушек или нераскрытых TODO. В handoff отдельно перечислены неподтверждённые runtime gates. Если C01 неразрешим без исполнения, внешняя capability недоступна или соседняя часть не готова, соответствующая строка остаётся OPEN/BLOCKED_BY с причиной — её нельзя закрыть ради одновременного финиша. Изменение кода всех трёх компонентов не считается доказательством end-to-end PASS.

При необходимости перераспределения переносить только ещё не начатый изолированный модуль вместе с его исключительным владением и записью в общем реестре. Активные общие engine/SQL/state файлы между чатами не делить. Дополнительные работы из-за найденного дефекта отражать явно; открытые пункты не скрывать и O01–O03 автоматически не добавлять.

### 6.8. Готовые задания для запуска трёх чатов оператором

Каждый текст ниже — самостоятельное начальное задание для отдельного чата в `C:/.projects/exocortex`. Его передача оператором начинает **соответствующую реализацию**, а не текущий этап редактирования документа. Этот разговор не создаёт и не запускает чаты автоматически.

**Чат 1 — CHAT-A / Saturn**

```text
Реализуй пакет CHAT-A из C:/.projects/exocortex/saturn/docs/implementation/IMPLEMENTATION_CHANGE_INVENTORY_2026-10-14.md. Сначала прочитай разделы 1–5 и 6–8, затем выполняй только свою часть матрицы 6.4. Текущая dirty рабочая область содержит ранее выполненную работу — сохрани её.
Ты владеешь Saturn, кроме нового packages/storage-verifier/ и личных файлов двух других чатов. Вначале подготовь versioned K1/K3/K4, затем K2 в PARALLEL_SYNC_CONTRACTS_2026-10-14.md; выдавай стабильные интерфейсы, не ожидая готовности всего backend. Реализуй server contracts/executor/mutations/coordination/migration/transport/adapters/scrub и интегрируй verifier от CHAT-C. К Neptune/Pluto/host module правки не применяй. Запросы и принятые revisions сверяй через parallel-2026-10-14/CHAT-B.md и CHAT-C.md; собственное состояние пиши в CHAT-A.md.
Веди журнал C:/.projects/exocortex/.history/2026-10-14-parallel-saturn.md: время/причина/входной гейт/действия/выходной гейт. Явно отмечай непроведённые проверки. Ты владелец общего интеграционного checklist; исправления в чужих файлах выполняет их владелец.
Сейчас разрешена реализация, но сборки/typecheck, тесты, запуск стендов/контейнеров, установка на storage host, публикация и deployment не разрешены. Шестичасовой прогон запрещён до отдельного явного указания. O01–O03 не реализуй автоматически. Заверши отчётом о коде, compatibility, contract revisions и оставшихся gates; не называй непроверенный путь PASS.
```

**Чат 2 — CHAT-B / Neptune**

```text
Реализуй пакет CHAT-B из C:/.projects/exocortex/saturn/docs/implementation/IMPLEMENTATION_CHANGE_INVENTORY_2026-10-14.md. Прочитай разделы 1–5 и 6–8; выполняй только свою часть матрицы 6.4. Сохрани текущие dirty изменения, original profiles/operations/receipts.
Ты единственный владелец neptune/. Начни независимые C01/C04 и updater/profile lifecycle, затем реализуй Windows namespace/transport/batches/streaming/retry/migration/status по READY revisions K1–K4 из PARALLEL_SYNC_CONTRACTS_2026-10-14.md. Общие TS/schema и Saturn/Pluto файлы не меняй. C01 не исправляй сбросом профиля или ослаблением proof; если нужна запрещённая динамическая диагностика, сохрани пункт открытым и продолжай независимые части.
Веди журнал C:/.projects/exocortex/.history/2026-10-14-parallel-neptune.md в формате время/причина/вход/действия/выход. Состояние, запросы к CHAT-A и принятые revisions записывай в C:/.projects/exocortex/saturn/docs/implementation/parallel-2026-10-14/CHAT-B.md; читай статусы соседей. Подключай свой код к обычному Windows flow; shared files меняет только их владелец.
Сейчас разрешена реализация, но сборки/typecheck, тесты, native runs, стенды/контейнеры, установка MSI, публикация и deployment не разрешены. Шестичасовой прогон запрещён до отдельного явного указания. O01–O03 не реализуй автоматически. В конце перечисли реальные правки, compatibility, принятые contracts и открытые validation gates; проверки без запуска не объявляй пройденными.
```

**Чат 3 — CHAT-C / Pluto + storage verifier**

```text
Реализуй пакет CHAT-C из C:/.projects/exocortex/saturn/docs/implementation/IMPLEMENTATION_CHANGE_INVENTORY_2026-10-14.md. Прочитай разделы 1–5 и 6–8; выполняй только свою часть матрицы 6.4. Сохрани существующую dirty работу и durable original state.
Ты владеешь pluto/ и новым отдельным saturn/packages/storage-verifier/. Начни C02/C03, затем внедри Go transport/state/config/CLI по READY K1–K3. Реализуй host-side verifier по K4 от CHAT-A; это отдельный TypeScript package, не расширение привилегий Pluto daemon. Общие Saturn contracts/storage adapters/file-core/root manifests/lockfile/CI не меняй — передавай требования CHAT-A через свой status. Подключение verifier к серверу выполняет CHAT-A. Сохрани backup semantics, лимит Pluto 256 MiB и retention 10 версий; source deletion не удаляет copies.
Веди журнал C:/.projects/exocortex/.history/2026-10-14-parallel-pluto-verifier.md: время/причина/вход/действия/выход. Состояние, contract revisions, dependencies и запросы записывай в C:/.projects/exocortex/saturn/docs/implementation/parallel-2026-10-14/CHAT-C.md; читай contract/status файлы других владельцев. Передай настоящий verifier implementation, не capability stub.
Сейчас разрешена реализация, но сборки/typecheck, тесты, запуск daemon/стендов/контейнеров, установка или запуск на remote host, публикация и deployment не разрешены. Шестичасовой прогон запрещён до отдельного явного указания. O01–O03 не реализуй автоматически. Заверши отчётом о коде, поддерживаемых capabilities/platforms, fallback, compatibility и непроверенных gates.
```

## 7. Границы реализации и открытые вопросы

Каждое задание включает собственный код, contracts, additive migrations, production wiring и документацию. Общие server primitives реализует CHAT-A, callers/state/UI — владелец клиента, host verifier — CHAT-C. Серверные MOVE/delete из C07 переиспользуются в C09/C10; повторная реализация тех же примитивов не нужна.

Открытые технические вопросы: точная причина C01, полный состав writers и handoff в C07/C08, совместимость streaming в C15 и возможности host verifier в C22. Новые находки фиксируются в личном handoff и общем реестре; неподтверждённые предположения не становятся завершёнными пунктами.

Тесты, установка, стенды, signing/deployment относятся к отдельному этапу. O01–O03 остаются условными. Если C22 или другая выбранная часть переносится, явно обновляются scope, владельцы и зависимости; пункт не исчезает из перечня незаметно.

## 8. Покрытие исходных этапов и отдельная будущая валидация

| Этап | Изменения кода по этому документу | Что остаётся за пределами текущего этапа |
|---|---|---|
| PERF-00 | C20, инструментирование C01 | Matched before/after, финальные метрики/когорта |
| PERF-01 | C19, связанные C18 | Final payload, native MSI install/update, signing/trust |
| PERF-02 | C06 | Amplification/100k lookup и concurrency measurements |
| PERF-03 | Additive state C02–C04, C09–C18; foundations уже есть | Crash/migration/rollback regression |
| PERF-04 | C07–C08, C18 | All-writer/PG/local/SFTP, UNKNOWN/handoff acceptance |
| PERF-05 | C06/C08/C15/C16 | Native large-tree initial, memory/IO и mixed resources |
| PERF-06 | C01–C05 | Valid steady-state zero-content-read, K10, gap/restart |
| PERF-07 | C09–C12 и серверный C07 | Rename/delete/conflict/collision/source identity scenarios |
| PERF-08 | C13–C17 и C06/C16 | Partial batches, resume, fairness, measured benefit |
| PERF-09 | Выбраны C21–C23; условны O01–O03 | Capability/integrity/benefit/fallback для включаемых функций |
| PERF-10 | C18–C19 | Реальные old/new upgrades/adoption, compatible rollback |
| PERF-11 | Новая отдельная бизнес-функция не требуется; validators уточняются при изменении contracts/packages | Регрессия, final bundle, qualification report. **6h запрещён** |

Последующая стратегия проверки: сначала проверки новых contracts/state transitions и исправленного C01, затем affected integration/native paths на одной согласованной версии, затем один полный регрессионный проход затронутых компонентов. Повтор полного прохода нужен после существенных исправлений/нового риска, а не после каждой редакции. Benchmarks проводить после correctness gates и при фиксированных условиях; не смешивать старую accepted cohort с новым payload. Это план, **ни одна из этих проверок сейчас не запускалась**.

## 9. Сохранность рабочей области и выход первого этапа

Репозитории уже содержали изменения предыдущей работы. `HEAD` не описывает фактическое рабочее дерево. Для текущего этапа сняты fingerprints файлов из `git ls-files --cached --others --exclude-standard` с исключением `docs/`, `.history/`, `.audit/` и документальных/изобразительных расширений. Это ограниченная проверка неизменности выбранных исходников/скриптов/config/tests, не полный backup и не product qualification.

| Репозиторий | HEAD | Файлов | Входной совокупный SHA-256 |
|---|---|---:|---|
| Neptune | `9eebcfebdc77e7b05605194092928457b8d81579` | 261 | `c4fc6f220805b7d1f87d3994b81ca9b690f688edd8acd493e8fa3ce41eedc6e8` |
| Pluto | `28b114b26754f43fd2cdd95d71e5cd5fdfa1c1a2` | 186 | `8ead777cb496c2eb294d7ef55000776f877bc2aa924b9f93bd88111f341db47e` |
| Saturn | `293a2d613fe3f97fcca401bb74381fe4997ec27b` | 617 | `7ea7fd38cc2b2e3415873244283acf7e97a24e9cdf879c1d9d8799ece1af1078` |

Выходной гейт документа: все C01–C23 имеют входное состояние, конкретное изменение, точки реализации, зависимости и критерий завершения кода; PERF-00–11 сопоставлены с работами; PERF-09 имеет явный выбор и условия. Проверка ссылок/нумерации документа и повторная сверка fingerprints фиксируются отдельной заключительной записью журнала. Дальнейшее изменение продукта и запуск проверок остаются приостановлены до указания оператора.

**Результат проверки документа, 2026-10-14T15:13:42+03:00:** C01–C23 присутствуют ровно по одному и в правильном порядке; все 119 локальных ссылок (80 уникальных путей) разрешаются. Повторный fingerprint всех 1064 выбранных файлов и HEAD трёх репозиториев совпал с входным. Historical Neptune cohort/counts дополнительно сверены с сохранённым JSON. Изменены только этот новый документ и журнал; product code, config, данные, сборки, тесты и runtime не затрагивались. **Первый этап завершён.**

## 10. Выход этапа 2 — распределение по чатам

**2026-10-14T15:41:29+03:00:** подготовлены CHAT-A/B/C. Для каждого заданы scope, исключительное владение файлами, independent work, входы/выходы и готовое стартовое задание; общие K1–K4, journals/handoff и интеграционный владелец определены. Матрица содержит все 23 C-ID ровно один раз, подробные C01–C23 сохранены. Локальные ссылки проверены. Повторные fingerprints 1064 выбранных файлов и HEAD трёх репозиториев совпали с входными данными этапа 2. Изменены только этот Markdown и исторический журнал; code/build/test/runtime не запускались и не изменялись. Новые чаты, агенты, worktrees, host package и будущие coordination-файлы на этапе 2 не создавались.

## 11. Реализация CHAT-A по отдельному поручению оператора

2026-10-14: серверная часть CHAT-A адаптирована в исходниках, включая additive 0062–0066, guarded mutations/streaming, backend executor, policy/adoption CLI, verifier integration и cooperative scrub. Подробности и явная supported/unsupported writer matrix — [handoff CHAT-A](CHAT_A_IMPLEMENTATION_HANDOFF_2026-10-14.md). Контракты — [K1 r2 / K2 r2 / K3 r2 / K4 r1](PARALLEL_SYNC_CONTRACTS_2026-10-14.md). Общий [C01–C23 checklist](PARALLEL_INTEGRATION_CHECKLIST_2026-10-14.md) отделяет server source completion от reported client status и незакрытых gates.

Предыдущие записи разделов 9–10 описывают прежние документальные этапы и не являются текущей проверкой неизменности продукта. Текущее поручение разрешило кодовые изменения только CHAT-A; Neptune, Pluto, host package и файлы B/C не редактировались этим исполнителем. Существующие тесты и 0057–0061 сохранены относительно входного snapshot CHAT-A. Никакие tests/build/typecheck/migrations/runtime/install/deployment/6h не запускались. K1 r2 принят B/C по status/source handoff; runtime PASS не заявляется, последующая qualification остаётся открытой.
