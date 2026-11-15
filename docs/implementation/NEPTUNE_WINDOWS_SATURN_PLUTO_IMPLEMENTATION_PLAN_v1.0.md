---
title: "План оптимизации Neptune Windows Saturn и Pluto"
version: "1.0"
date: "2026-10-12"
status: "Выполнение начато; этапы принимаются по доказательствам"
---

# План оптимизации Neptune Windows Saturn и Pluto

Программа устраняет повторную подготовку каталогов при первоначальной передаче и обработку всего дерева при обычной повторной синхронизации. Основной клиент — устанавливаемый Neptune Windows. Portable остаётся второй упаковкой тех же бинарников. Pluto получает собственные оптимизации обнаружения, планирования и передачи, используя общие возможности Saturn и сохраняя правила резервного копирования.

Основа: [спецификация производительности v1.0](C:/.projects/exocortex/saturn/docs/NEPTUNE_SATURN_SYNC_PERFORMANCE_SPEC_v1.0.md). Этот план уточняет её для текущих репозиториев, выпуска Windows и Pluto. Обозначения S01–S14, T01–T20 и A01–A42 сохраняют значения исходной спецификации. Этапы PERF отделены от существующих этапов развития Saturn.

## 1. Область работ и принятые решения

1. Пользователь приостановил синхронизацию большой папки. Разработка и измерения используют отдельные локальные профили, roots и тестовые данные. Обновление сохраняет паузу; установка или миграция не возобновляет исходный mapping автоматически.
2. Один проект `Neptune.Windows` и общий `Neptune.Core`; отдельного исходного проекта для portable нет. CI выполняет один publish Windows и упаковывает его результат в устанавливаемый пакет и ZIP. Профиль, протокол и формат состояния одинаковы.
3. Устанавливаемая версия — основной сценарий приёмки: установка, автозапуск, tray, обновление, восстановление и удаление приложения. Формат первого установщика — per-user MSI без обязательного повышения прав. Сборщик и его версия фиксируются в packaging lock до начала PERF-01; лицензия, доступность в CI и воспроизводимость являются входными проверками. MSIX не является обязательным условием программы.
4. Состояние хранится в защищённом каталоге пользователя вне синхронизируемого дерева. Смена portable на установленную упаковку сохраняет существующие device/mapping/profile identity и привязки серверных roots. Установка не создаёт второй default profile.
5. Neptune работает в `upload_mirror_guarded`: самостоятельные серверные изменения становятся конфликтами; автоматического скачивания и безусловной перезаписи нет. На root допускается один Neptune writer device и один владелец локального профиля.
6. Pluto сохраняет backup-семантику: отсутствие источника не удаляет серверную копию; сохраняются текущие права, ограничение файла 256 MiB и максимум 10 активных версий, включая текущую. Расширение этих лимитов является отдельной задачей, а не побочным эффектом оптимизации. Правила ссылок Pluto сохраняются: ссылки на обычные файлы допускаются с проверкой смены target; каталожные ссылки и специальные файлы отклоняются.
7. Общий серверный протокол обслуживает оба клиента через разные политики и scopes. Права на Windows moves/deletes не выдаются Pluto. Клиенты используют свои локальные базы; общий API не означает общий файл SQLite между C# и Go.
8. Все 14 системных и 20 точечных решений включены в программу. Зависимые от возможностей backend ускорения включаются после измерений. Их отсутствие не блокирует базовые первоначальную передачу, дельту объектов и восстановление.
9. Сохраняются пользовательские незакоммиченные изменения. Каждый этап имеет отдельную идентичность исходников и сравнивается с зафиксированной предыдущей когортой. Публикация релизов, развёртывание на production и возобновление большого mapping не выполняются автоматически при завершении локальных проверок.
10. После завершения реализации и обязательной этапной приёмки выполняется локальный шестичасовой Saturn + установленный Neptune Windows + Pluto stress с heartbeat каждые 30 минут, разрешёнными локальными repair/retry и парным before/after измерением времени/ресурсов. После шести часов новые rounds не допускаются; последний начатый доводится до конца. Подробные gates, сценарии и критерии: [план шестичасовой приёмки](C:/.projects/exocortex/saturn/docs/implementation/SYNC_RELIABILITY_6H_ACCEPTANCE_PLAN.md). Прогон пока не запущен.

## 2. Проверенная исходная структура

| Область | Текущее устройство | Следствие для реализации |
|---|---|---|
| Windows | Один WPF-проект с общим Core; CI публикует self-contained portable ZIP | Добавить установщик поверх единого publish и обновить manifest/verifiers, не создавать второй sync engine |
| Neptune initial | Полное дерево материализуется в память; сначала каталоги, потом файлы; цепочки родителей подготавливаются повторно | Потоковый scanner, постоянная очередь и уникальные dependencies |
| Neptune repeat | Для неизменённого локального файла проверяется серверный ETag; завершающий mirror перечисляет remote | L/B/R, локальный журнал и server feed вместо пофайловых проверок |
| Saturn path resolution | DeviceService ищет имя через страницы children; repository уже имеет индексированный getChild | Переиспользовать существующий индекс с сохранением legacy-семантики имён |
| Saturn execution | API и worker имеют отдельные FileService/StorageManager | Общая координация записи и бюджетов должна охватывать оба процесса |
| Saturn protection | Уже существуют upload recovery, reconciliation, storage catalog, integrity scrub и Drop buffer | Расширять существующие механизмы, избежать параллельных реестров одной операции |
| Pluto | Последовательный обход; cache родителей живёт один Copy; содержимое захватывается/хешируется до решения о пропуске | Постоянный индекс, dirty queue, ограниченные workers, сохранение подтверждений |
| Compatibility | Neptune Linux использует Core; Pluto и другие пути пишут через Saturn file-core | Регрессионные проверки этих путей обязательны после изменений общего кода |

Источники: [Windows sync](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsSyncService.cs), [Windows packaging](C:/.projects/exocortex/neptune/packaging/windows/README.md), [release workflow](C:/.projects/exocortex/neptune/.github/workflows/release.yml), [DeviceService](C:/.projects/exocortex/saturn/packages/sync/src/device.service.ts), [Pluto Copy](C:/.projects/exocortex/pluto/internal/pluto/copy.go).

## 3. Затронутые проекты

| Проект | Изменения | Обязательные связанные проверки |
|---|---|---|
| Neptune | Core state/migrations/transport/contracts; Windows scanner, journal adapter, scheduler, UI, updater; installer/portable packaging и release validators | Windows native installed + portable; Core/Linux regression; upgrade и profile ownership |
| Saturn | sync, file-core, database, storage, contracts, config; интеграция protection/drop; API, worker, web и ingress configuration | HTTP обоих клиентов; PostgreSQL; SFTP и local backend; Drop, backups, version restore, UI mutations |
| Pluto | Постоянный индекс и операции, scanner/watcher fallback, scheduler, transport, update/migration/status | Go/Linux daemon + TUI; scopes, versions, symlinks, permissions, restart/upgrade |
| Kernel | Discovery нового endpoint/capabilities и allowlist Outdoor presets при необходимости | neptune-v1 и pluto-v1 получают только нужные координаты; старые токены/discovery совместимы |
| Updater | Поддержка порядка обновления и health/rollback для новой топологии Saturn, если состав процессов изменяется | Остановлен старый backend writer; API/worker совместимы со схемой; откат сохраняет публикации |
| Mastermind | Только существующий вспомогательный генератор Unicode-таблиц, если он остаётся владельцем генерации | Общие векторы и фиксированная версия codec; runtime Mastermind не меняется ради этой программы |
| Gryphon | Алгоритм передачи файлов не изменяется | Совместимость существующих уведомлений при изменении статусов Saturn |

## 4. Правила приёмки каждого этапа

После каждого этапа выполняются четыре группы проверок: корректность и целостность; эффективность; взаимодействие элементов; обновление/восстановление затронутого состояния. Матрица определяет конкретные проверки. Для этапа с клиентским поведением HTTP fixtures дополняются прогоном настоящего клиента; fixtures сами по себе не доказывают работу WPF, установщика или Linux daemon.

Статусы: `PLANNED`, `IN_PROGRESS`, `PASS`, `FAIL`, `BLOCKED`, `N/A`. `PASS` требует ссылку на сырые результаты, идентичность когорты и выполненный критерий. `N/A` допускается для конкретного неприменимого сценария с причиной; обязательный сценарий нельзя заменить отсутствием среды. Этап считается принятым только при PASS всех его обязательных строк. Частичное изменение с зелёными unit tests не означает принятие всего этапа.

После исправления повторяются затронутые проверки и общий smoke. Полный performance baseline повторяется при изменении условий/лимитов или необъяснённой регрессии. Не расширять concurrency для сокрытия ошибок, не сравнивать новый непроверяемый путь со старым путём с проверкой сохранённых байтов.

По разрешению пользователя реализация первых независимых инкрементов распределена между агентами: Windows packaging, Neptune parent preparation и Pluto transfer. Общие изменения Saturn, документация и сквозная приёмка выполняются одним интегратором. Каждый агент фиксирует собственный patch поверх исходных dirty files, работает в отдельной области и передаёт результат вместе с тестами. Назначение агенту не меняет критерии принятия этапа. Зависимые серверные контракты и клиентские миграции интегрируются по очереди после общего gate.

После их локальной приёмки выполнен второй блок: SQLite state/migration обоих клиентов и readonly Saturn metadata batch. Общие свежие HTTP/PG прогоны прошли на local и реальном SFTP-адаптере; бинарники копируются и хешируются для каждой попытки. Ускоренный пропуск по L/B/R пока не активен. Результаты конкретных инкрементов и ограничения приведены в [матрице выполнения](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_ACCEPTANCE_MATRIX.md).

Текущие конкретные задачи агентов: Neptune — opt-in Core bootstrap executor поверх принятого bounded scanner; Pluto — distribution нового SQLite runtime после принятого streaming Copy enumeration; Saturn — immutable Windows upload publication receipt после принятого coherent logical backup/guarded recovery. Каждый increment имеет отдельную когорту и проверку миграции. Planner не подключён к Copy/daemon; Core executor не активирует Windows engine. Включение нового движка требует закрытия отдельных gates.

Оперативный статус 2026-10-12: opt-in первичная потоковая передача Core принята отдельным инкрементом, включая 3 full Core runs по240/240 и common local/SFTP с frozen Core/Copy,34files/client и68SHA readbacks в каждом. Independently reproduced caller-context scheduling stall исправлен; причины двух прежних unsnapshotted flaky runs не объявляются доказанными. Saturn receipt проходит focused real PG/HTTP и legacy regressions после исправления SQL deadlock; финальная когорта и независимая приёмка ещё нужны. Pluto signed schema2 assets и notices проверяются на изолированной установке; автоматический переход старого updater на schema2 остаётся открытым. Повторная синхронизация через квалифицированные dirty queues/feed и сравнение L/B/R пока не активирована.

Подтверждённый SFTP дефект исправлен: healthy lease сохраняется после ожидаемого RPC `NO_SUCH_FILE` и других квалифицированных semantic statuses; timeout/disconnect/повреждение транспорта сохраняют retirement. На том же малом mixed fixture с теми же frozen clients Neptune initial составил 32079→3766 ms, Pluto 32764→4702 ms, read-back всех 66 SHA-256 прошёл. Это один парный стендовый прогон с artificial HTTP latency, не большая production qualification или доказательство общего 3× gate.

Принят отдельный coherent logical backup/guarded recovery increment: dump и bounded JSONL читают один PG cut, registered journal сохраняет clocks/events/receipts вместе с upload dependencies, legacy transient policy остаётся отдельной. Registered-root automatic restore пока блокируется до explicit backend reconciliation; storage switch и полный runtime writer coverage остаются обязательными gates. Следующий серверный increment исправляет mutable current-version ответ при replay завершённого upload: нужна сохранённая immutable publication receipt, отдельная от текущего состояния файла.

На каждый этап сохраняются: исходные revisions и dirty hashes; patch этапа; версии инструментов и image digests; dataset manifest; backend capabilities; конфигурация/лимиты/RTT; raw logs и интервальные метрики; результаты хешей, namespace, history и recovery; manifest приёмки. Данные секретов и содержимое пользовательской большой папки в benchmark не копируются.

## 5. Поэтапные изменения

### PERF-00 Исходная когорта и измерительный стенд

**Результат:** воспроизводимый baseline и отдельный стенд для сравнения Neptune, Pluto и смешанной нагрузки.

- Сохранить revisions, существующие diffs и hashes незакоммиченных файлов до правок. Зафиксировать фактические build identities; production identity требуется перед canary, не выводится из локального HEAD.
- Зафиксировать stage counters и ресурсы, подготовить независимые тестовые profiles/roots и synthetic datasets. Production profile не используется как тестовый writer.
- Выполнить существующие Core/Windows build, Go, Saturn unit и HTTP integration проверки до изменений.
- Добавлять счётчики T18: metadata requests, source bytes read, retry bytes, SQL/SFTP operations, pool wait, received/written/verified/published, oldest pending и journal lag. Высокая кардинальность путей в metric labels запрещена.
- Проверить свободное место/резервы, принадлежность контейнеров и доступные backend capabilities; разделить HDD/SSD, cold/warm cache и measured/artificial RTT.

**Миграция/откат:** резервные копии тестовых профилей и схем; исходные пользовательские файлы не изменяются. Из работающего SQLite разрешён consistent Backup API; одно копирование DB без WAL не считается backup.

### PERF-01 Одна сборка Windows и две упаковки

**Результат:** устанавливаемый MSI и portable ZIP из одного опубликованного payload.

- Один publish `Neptune.Windows`; общий engine/core, commit, assembly version, protocol version и hash каждого payload-файла. Различается packaging metadata.
- Installer размещает приложение отдельно от профиля, регистрирует удаление/ярлыки и корректный per-profile autostart. Удаление приложения по умолчанию сохраняет profile/device identity.
- Расширить release manifest до списка вариантов с compatibility bounds и payload identity; сохранить читаемый старым portable updater manifest на переходный период. Обновить exact-asset validators, CI и загрузку обновлений для каждой упаковки.
- Installed updater использует поддерживаемый installer transaction; portable — безопасную замену каталога. Обоим необходимы pause/checkpoint, проверка подписи/hash, остановка владельца профиля и сохранение предыдущего package до health check.
- Portable → installed и обратный поддерживаемый переход работают с одним выбранным профилем. Profile mutex и root ownership исключают второй writer. Новая упаковка не сбрасывает флаг паузы.

**Приёмка:** W01–W10. Публикация bundle заблокирована при отсутствии любого обязательного Windows artifact, несовпадении payload или неподтверждённой схеме обновления. Подписанный release manifest не подменяет требования ОС к подписи выбранного установщика; test certificate не выдаётся за production trust.

### PERF-02 Прямой поиск и устранение повторов родителей

**Результат:** разрешение одного сегмента не перечисляет соседей; подготовка одного родителя объединяется и сохраняется.

- DeviceService Neptune/Pluto использует существующий indexed repository lookup. На первом переходе сохраняются точное совпадение legacy-имён, active parent/child validation и scope/ACL checks. Unicode policy не меняется вместе с поисковой оптимизацией.
- Для Neptune/Pluto ввести singleflight по идентичности parent, bounded positive/negative cache и постоянное сопоставление directory ID после подтверждения. Ошибка существования проверяет type/root; любой 409 не считается успехом.
- Убрать повторные цепочки MKCOL/GET/POST из файловых задач. При invalidation повторно разрешается конкретная ветвь.
- Пакетный resolver/ensure подготовить как контракт; включение выполняется в PERF-05 после серверного operation registry.

**Приёмка:** lookup target/missing в каталоге с 100k children имеет фиксированное число SQL обращений; 100 конкурентных файлов одного parent имеют одну логическую подготовку; scopes и legacy case-sensitive результаты сохранены. Полный wall-clock эффект измеряется на реальном indexed PostgreSQL и конечном backend.

### PERF-03 Постоянное состояние операций и миграции клиентов

**Результат:** клиент после restart знает согласованное состояние и продолжает отдельные операции.

- Neptune: расширить существующий SQLite до L/B/R, generations, roots, scan scopes, dirty entries, operations/dependencies, chunks и conflict records. Один writer, WAL, prepared statements и bounded batch transactions; тяжёлое сетевое I/O вне SQL transaction.
- Pluto: добавить локальную transactional SQLite state store в существующий protected StateDir. Выбрать и закрепить драйвер, совместимый с поддерживаемыми Linux architectures и release build, до schema implementation. Это отдельная Go-реализация, не запуск .NET внутри Pluto.
- Сохранить старые таблицы/Config/status и migration journal. Legacy baseline без достаточных данных — UNKNOWN. Device credentials, source list, intervals, mapping identity и пользовательские лимиты сохраняются.
- Записывать operation ID и immutable intent до I/O. Подтверждать только обработанное поколение; g+1 остаётся pending после ACK g. Leases и status query разрешают неизвестный результат.
- Сформировать persistence contract для parent dependencies, per-file receipts, spool refs и курсоров. Cursor и порождённая dirty work фиксируются одной транзакцией.

**Приёмка:** A08, A11–A13, A15, A19, A41/A42 в части client state; crash/restart не очищает согласованные B и не повторяет подтверждённые bytes. Pluto migration сохраняет backup semantics.

### PERF-04 Общий протокол Saturn и безопасная публикация

**Результат:** Saturn подтверждает конкретную проверенную публикацию и предоставляет согласованную историю состояния.

- Версионированный sync API в принятой маршрутизации Saturn, capabilities и minimum writer versions. Общие C#/TypeScript/Go schemas и golden vectors для int64 decimal strings, IDs, SHA-256, canonical intent и name codec.
- Operation registry и компактные receipts; durable backend intents связывают приём, storage verification, namespace publication и короткий catalog commit.
- Root journal в порядке фиксации: root clock, catalog change и receipt атомарны. Не использовать MAX(BIGSERIAL) как доказательство отсутствия пропущенных commits. Root clock не держится во время SFTP передачи.
- Согласованный metadata snapshot at cut C; shadow import, keyset pagination и feed после C. Incomplete remote state не означает absence. Late snapshot/ACK не откатывает более новое R.
- Общий backend writer/executor и budgets для API/worker и остальных затронутых путей. Namespace guards и CAS применяются ко всем mutations наблюдаемого root. Basic SFTP takeover допускается только после подтверждённой остановки прежнего writer, а не по истечению lease.
- Сохранить backend readback/verification. Расширить existing upload recovery и protection. HTTP readers не получают новые bytes со старым catalog во время незавершённой публикации.
- Retention/quotas snapshots, changes, receipts, history и temp задаются явно. Не удалять receipt активной/неподтверждённой операции по одному возрасту. External direct-SFTP writes требуют observation/reconciliation capability или режима managed-exclusive root.

**Приёмка:** реальные HTTP/PG/local/SFTP round trips обоих клиентов; A09/A10, A13/A14, A24–A26, A28–A31, A33/A34/A42; Drop/backup/UI mutations не обходят guard/journal. Во время миграции новые features отключены до handshake.

### PERF-05 Потоковая первоначальная передача и фиксированные бюджеты

**Результат:** scanner/planner/executor перекрываются и не содержат целое дерево в RAM.

- Постоянная scan queue и признаки complete/incomplete каждой области. Перечисление метаданных порциями; отсутствие доступа блокирует конкретную ветвь.
- Directory ensure/resolve batches до 500 items и 4 MiB uncompressed; local parent refs, ID addressing, per-item результаты и единая подготовка зависимостей.
- Обычная загрузка начинается после подготовки её родителей. Empty dirs сохраняются. Незнакомые серверные объекты в bootstrap не удаляются.
- Общие client budgets: initial data workers 4, large workers <=2, metadata <=8, HDD/unknown readers 1, SSD readers 2, managed buffers <=64 MiB. Server: initial storage workers 4 и managed buffers <=128 MiB; бюджеты общие между клиентами/процессами.
- HTTP client pooling, streaming без whole-file buffering, connect/metadata/inactivity timeouts; проверка ingress limits. Byte-weighted scheduling live/bootstrap/recovery с aging и backpressure.
- Удалить обязательный полный финальный PROPFIND из нового completion path; завершение определяется local cut, receipts и feed. Legacy deletion path не остаётся активным с удалённой проверкой полноты.

**Приёмка:** A01/A04/A05/A23/A28; D3/D4 не упираются в root limit 100k или линейную память. Передача готового файла стартует до окончания scan; принимается полный итоговый manifest, а не только число приёмов.

### PERF-06 Дельта объектов Neptune и Pluto

**Результат:** обычный цикл обрабатывает изменения, а не выясняет состояние каждого файла заново.

- Windows: USN reader один на volume, проверка volume/journal identity и retained range. Начальный barrier capture/scan/replay исключает пропуски при bootstrap. Privileged helper минимален и optional; UI не требует admin.
- Watcher быстро записывает hints в durable dirty queue. Debounce по объекту: quiet 750 ms, max age 5 s; события g+1 не стираются завершением g. Overflow/restart uncertainty сохраняются.
- Server feed с persistent cursor и bounded long-poll; уведомление — hint, журнал — источник изменений. Health timer не запускает whole-tree pass.
- Pluto/Linux: inotify adapter и persistent dirty queue для работающего daemon; обрабатывать rename, watch overflow и недоступность источника. У Linux inotify нет обещания устойчивого журнала между остановками: после gap/restart требуется возобновляемая metadata reconciliation; в strict uncertainty совпадение size/mtime не считается универсальным доказательством неизменности.
- В valid steady state ни один клиент не делает per-file HTTP или чтение содержимого неизменённых объектов. После неизвестного интервала действует явный recovery path. Pluto поддерживает свой observation interval, но он планирует catch-up/health, а не повторный content capture всего дерева при достоверном индексе.

**Приёмка:** A02/A03/A08/A15/A20/A21/A22 и P02/P03/P05. Для обычного цикла сравнить 1700 и 500k objects; отдельно измерить recovery после gap, не подменять им steady-state benchmark.

### PERF-07 Namespace правила конфликты и безопасные изменения

**Результат:** быстрый rename и корректное поведение при исключениях, удалениях и неоднозначных именах.

- Версионированный NameCodec, shared golden vectors и collision dry-run. Старые roots сохраняют фактический legacy codec; portable_v1 включается отдельной namespace migration. Имена не переименовываются автоматически.
- Rename/move внутри root по стабильным IDs, без content upload потомков. Повторно проверять namespace/rights при publication после concurrent move.
- Versioned excludes и plan preview; исключение ранее managed области сохраняет серверные данные. Никаких silent excludes `.git`, `node_modules`, `.audit`.
- Neptune delete: только baseline-managed объект и подтверждённое локальное отсутствие, expected version, postorder CAS, quarantine/history и plan-bound mass-delete approval. UNKNOWN/incomplete не создают DELETE.
- Pluto: source deletion/отключение/сужение source list сохраняют copies; MOVE/DELETE capabilities Windows не включаются для Pluto. Retention 10 versions применяется к его новым публикациям как прежде.
- Root identity, mount change, overlap policy, path traversal, hardlink entry identity, case-only rename, junction/symlink boundaries проверяются отдельно для каждого клиента.

**Приёмка:** A06/A07/A09/A22/A23/A27/A30/A32/A35 и P04/P06/P07/P08. На migration dry-run нет неожиданных overwrite/delete и отсутствует смена codec без подтверждённой проверки.

### PERF-08 Пакеты хеширование в потоке и адаптивная нагрузка

**Результат:** ускорена передача действительно нужного содержимого при доказанной выгоде.

- Для small files <=256 KiB: manifest + binary parts, до 500 файлов и 32 MiB content, batch age bulk <=1000 ms/live <=250 ms. Immutable local spool и отдельные ACK/retry для каждого файла; не удерживать сотни открытых source handles.
- Empty files создаются без отдельных upload sessions; metadata-only update допускается только при доказанной неизменности содержимого.
- Whole-file upload: chunk и whole SHA при чтении стабильного источника; final seal, server readback и проверка actual source generation. Нельзя составить whole SHA путём хеширования конкатенации chunk hashes.
- Chunk resume по operation/source identity и подтверждённым chunk hashes; не смешивать две версии файла. Busy source имеет отдельную причину и delayed retry.
- Измерить реальную SFTP request window/pool wait до тюнинга. Global adaptive scheduler меняет concurrency по полезной публикации и latency, учитывает 429/503, circuit breaker и cooldown.
- Admission учитывает client spool, ingress reserve, backend новую версию плюс историю, refs/leases temp. Сохранить существующие пользовательские bandwidth limits.
- Metadata gzip при agreed capability и uncompressed limit; content compression только после доказанной выгоды, исходный SHA независимо от wire encoding.

**Приёмка:** A16–A19/A28/A29/A33; >=15% выигрыш batching относительно нового individual path и live latency ухудшается не более 20%. Source read amplification обычного stable unique whole-file пути стремится к 1; resume/delta измеряются отдельно. CPU/IO/RAM budgets соблюдаются для смеси двух клиентов.

### PERF-09 Ускорения по возможностям backend

**Результат:** optional ускорения доступны без ослабления гарантий и с корректным fallback.

- Storage-local verifier/agent внедряется только при доступности установки на host конечного диска и проверенном fencing/durability contract. Basic SFTP остаётся полноценным fallback.
- Authorized clone/content reuse по известному сильному hash и разрешённой области. Не предхешировать все новые large files ради вероятного отрицательного lookup. Не использовать mutable hardlinks для независимых copies.
- Fixed-block delta для файлов >=256 MiB, immutable base, bounded manifests, backend-side reuse/assembly и whole verification. Включать при missing <=25% и прогнозируемом >=20% выигрыше полной стоимости; poor match → whole-file fallback. Базовое ограничение Pluto 256 MiB сохраняется.
- Merkle metadata reconciliation для восстановления больших индексов после feed gap; не заменяет обычный feed. Согласованный cut, stable buckets и ограниченные ресурсы.
- T17: explicit application export/ограниченный snapshot source для активных данных. VSS/helper optional; не останавливать приложения автоматически. Неконсистентная копия живой БД не выдаётся за application backup.
- Scrub использует существующий Saturn protection с отдельным курсором и IO budget; отсутствие сетевых HEAD не отменяет проверку физических байтов.

**Приёмка:** A34/A36–A39 и tests capture/space/TTL. Для каждой функции отдельный capability proof, benefit report и fallback test; неподдерживаемая функция остаётся OFF.

### PERF-10 Сквозная миграция и продолжение старых загрузок

**Результат:** новая версия безопасно продолжает существующие mappings и backups.

- Upgrade order: Saturn additive schema/API/capabilities → клиентские packages → per-root activation. До activation старые поддерживаемые клиенты работают в legacy mode; после смены root epoch/min writer несовместимый старый writer получает явный отказ.
- На copies старых profiles выполнить repeatable migration + plan-only adoption. Сохранить credentials, identity, pause, schedules, limits, paths, server bindings и completed receipts. Profile copy не пишет в исходный production root.
- Adopt существующие dirs по ID/type/root и files по достаточному content/version proof. UNKNOWN baseline не превращается в разрешение перезаписи.
- Partial legacy uploads продолжать только при совместимых session/source/format. Несовместимые временные данные сохраняются quarantined; уже опубликованные файлы не загружаются заново.
- Проиграть interrupted upgrade и binary/feature rollback. Feature flags откатывают optional acceleration без отката базового индекса. Старую БД нельзя восстановить поверх новых публикаций и включить legacy удаления.
- Добавить inspect/pause/checkpoint/backup/migrate-plan/adopt/resume/diagnostics CLI только вместе с реализацией. Команды source spec не считаются уже существующими.

**Приёмка:** W04–W09, P09/P10, A13/A19/A24/A41/A42; сочетания old/new client/server. На большом synthetic root и на копии реального профиля повторно передаются только доказанно нужные bytes. Возобновление исходного пользовательского mapping — отдельное действие оператора после принятой миграции.

### PERF-11 Итоговая проверка и подготовка release bundle

**Результат:** согласованный набор Saturn + Neptune Windows installed/portable + Pluto, готовый к публикации.

- Полная регрессия всех затронутых компонентов и native Windows/Linux canary. Принять смешанную нагрузку двух клиентов, outages, backend reconnect, runtime profile switch и работу других Saturn функций.
- Финальный bounded endurance на отдельном стенде с фиксированным deadline, watchdog, ownership labels и ресурсными limits. Длительность и критерии объявляются до старта; прежний завершённый 12h run не продолжается и его результаты не смешиваются с новой когортой.
- Windows bundle содержит MSI, portable ZIP, оба manifests/подписи/checksums, общий payload identity, migration/rollback notes и qualification report. Старые обязательные Linux Neptune assets сохраняются; это не две кодовые базы Windows.
- Release validators проверяют exact asset set, minimum compatible schema/API/writer и привязку отчёта к той же revision/artifact hash. Production signing keys используются только установленным процессом выпуска.
- Сохранить previous package/profile backup и runbook для принятого recovery; объявить ограничения USN fallback, Basic SFTP, активных данных и optional acceleration.

**Приёмка:** все обязательные строки матрицы PASS; optional N/A имеют capability reason и tested fallback. Публикация/production deployment отделены от локальной подготовки.

### 5.1 Зависимости и промежуточные выпуски

PERF-01 и PERF-02 независимы после baseline PERF-00: общий indexed lookup допускается до готовности installer. PERF-03 задаёт состояние для PERF-04/05/06; PERF-04 — серверные гарантии для PERF-05/06/07/08. Старый codec остаётся действующим до PERF-07. PERF-09 не блокирует выпуск базовых оптимизаций при отключённых optional features. PERF-10 проходит для каждого выпуска, меняющего состояние, упаковку или protocol bounds, а не только один раз в конце программы.

| Выпуск-кандидат | Минимальные завершённые работы | Что принимается перед публикацией |
|---|---|---|
| RC-A | PERF-01/02 | Две упаковки, совместимый lookup, текущий sync contract; applicable PERF-10 и release gates |
| RC-B | PERF-03/04/05 | Возобновляемая streaming initial передача, новая publication/index модель; applicable PERF-10 |
| RC-C | PERF-06/07 | Дельта объектов обоих клиентов и guarded namespace; полный steady-state gate и PERF-10 |
| RC-D | PERF-08 | Measured batches/hash pipeline/adaptation; partial-failure/mixed-load gates и PERF-10 |
| RC-E | Включаемые части PERF-09 | Отдельные capability/benefit/fallback gates и повтор applicable PERF-10 |

RC обозначает готовый кандидат, а не автоматическую публикацию. PERF-11 выполняет итоговую qualification выбранного набора features; отдельный кандидат также должен пройти все затронутые release checks.

## 6. Матрица принятия этапов

| Этап | Эффективность | Работоспособность и целостность | Взаимодействие | Миграция и восстановление | Состояние |
|---|---|---|---|---|---|
| PERF-00 | Baseline requests/source reads/published rate на D1/D2; одинаковые условия сравнения | Существующие тесты; manifests/hash fixtures | Neptune Core, Pluto Go, HTTP Neptune/Pluto, PG + local/SFTP профиль | Copies/backup procedure и dirty-source inventory | IN_PROGRESS |
| PERF-01 | Installed/portable engine throughput эквивалентен при одинаковом payload/config | W01–W03/W10, native install/tray/autostart/uninstall | Оба artifacts проходят discovery/enrollment и server smoke | W04–W09, pause/identity/checkpoint сохранены | IN_PROGRESS |
| PERF-02 | Фиксированное число lookup queries; 0 page enumeration для child lookup; one parent ensure | Target/missing/case/type/active tests, A04/A05 | Windows/Pluto HTTP scopes и existing file-core callers | Старые names/paths/API работают; откат без schema change | IN_PROGRESS |
| PERF-03 | Bounded SQLite batches, queue/RAM, no repeated confirmed bytes | A08/A11–A13/A15/A19 | State → transport → receipts для обоих клиентов | Legacy schema → new, crash mid-migration, repeatable recovery | IN_PROGRESS |
| PERF-04 | Feed/snapshot paging; short root-clock transaction; budget общий | A09/A10/A13/A14/A24–A26/A28–A34 | API/worker, HTTP/PG/SFTP; Drop/backup/UI входят в общий mutation core | Old/new negotiation; takeover и publish recovery | IN_PROGRESS |
| PERF-05 | D3/D4, first transfer до конца scan, no files×depth growth | A01/A04/A05/A23/A28, итоговые bytes/dirs | Настоящие Windows client и Pluto daemon на стенде | Restart mid-bootstrap, no-delete adoption | IN_PROGRESS |
| PERF-06 | A02/A03: no per-file HTTP/content reads; работа по изменившимся объектам | A08/A15/A20–A23, journal gaps | Native USN/inotify ↔ client state ↔ server feed | Restart/offline/gap; отдельная strict recovery path | PLANNED |
| PERF-07 | Rename 20k descendants с 0 content bytes; адресные invalidations | A06/A07/A09/A22/A23/A27/A30/A32/A35 | NameCodec C#/Go/TS/SQL, права обоих клиентов, UI conflicts | Legacy codec migration, changed excludes, history/quarantine | PLANNED |
| PERF-08 | >=15% batch improvement; latency +<=20%; measured read amplification | A16–A19/A28/A29/A33, per-item recovery | Mixed clients, proxy, ingress, SFTP pool, server writer | Lost replies/chunks; acceleration flag rollback | PLANNED |
| PERF-09 | >=20% predicted/confirmed full-cost benefit для delta; clone/agent measured | A34/A36–A39 и capture verification | Capability negotiation; agent/Basic SFTP fallback | Base leases, GC, unsupported capabilities и flag rollback | PLANNED |
| PERF-10 | Resume/adoption bytes отдельно; нет повторной передачи completed files | A13/A19/A24/A41/A42, W04–W09/P09/P10 | Compatibility combinations обеих упаковок/Pluto/Saturn | Pause, identity, history; interrupted update/binary rollback | PLANNED |
| PERF-11 | Итоговые medians/p95 и bounded endurance; telemetry <=5% overhead | A01–A42 для включённых features, W/P cases, hashes/history | Native Windows/Linux + PG/SFTP + other Saturn services | Release bundle exact assets и rehearsed rollback | PLANNED |

Все наборы end-to-end performance выполняются минимум трижды; отчёт содержит медиану и p95 стадий. Отдельный результат без fault injection не заменяет recovery gate.

### 6.1 Дополнительные проверки Windows упаковки

| ID | Проверка | Критерий PASS |
|---|---|---|
| W01 | Одна сборка в MSI и ZIP | Commit/version/protocol одинаковы, SHA каждого engine payload файла совпадает; сборка Windows единственная |
| W02 | Clean install обычным пользователем | Приложение запускается, tray/autostart работают, профиль вне install directory; runtime prerequisites учтены |
| W03 | Uninstall/reinstall | Удалены выбранные application registrations, профиль и device identity сохранены; paused mapping не стартует |
| W04 | Portable → installed | Выбран прежний профиль, device/root identity прежние; другой writer не появляется |
| W05 | Installed → installed update | Valid package, checkpoint, atomic installer outcome, health check; продолжается pending work |
| W06 | Portable update | Valid package, безопасная замена, identity и paused state сохранены |
| W07 | Install/update прерваны на каждой существенной границе | Восстановима старая или новая версия; профиль не потерян; неопределённые публикации разрешаются receipts |
| W08 | Старый exe запускается после root/schema migration | Поддерживаемый legacy mode либо явный запрет; нет записи несовместимым engine |
| W09 | Rollback после новых server publications | Новый профиль/receipts сохранены; adopt/reconcile перед resume, no-delete до согласования |
| W10 | Повреждённый/чужой artifact, параллельный запуск | Подпись/hash/compatibility отклоняют пакет; mutex/root ownership исключают concurrent writers |

### 6.2 Дополнительные проверки Pluto

| ID | Проверка | Критерий PASS |
|---|---|---|
| P01 | Initial configs tree | Empty dirs и поддерживаемые файлы опубликованы; stream/queues bounded; SHA/versions подтверждены |
| P02 | Повтор без изменений при valid evidence | 0 per-file network/content capture, нет новых версий; служебные requests ограничены |
| P03 | Изменение небольшого подмножества | Переданы только новые версии; race g/g+1 не теряет последнюю |
| P04 | Удаление источника/сужение source list | Серверные copies сохранены, DELETE не отправляется |
| P05 | Daemon остановлен, inotify gap/overflow | Persistent uncertainty; metadata/при необходимости content reconciliation; отсутствие silent skip |
| P06 | Permission denied у одной ветви | Остальные sources работают; конкретная ошибка сохранена, нет infer-delete |
| P07 | File symlink/retarget, directory link, special file | Текущая политика сохранена; смена target обнаружена, публикация правильной версии |
| P08 | 11 и более изменений, 256 MiB boundary | Не более 10 активных версий; превышение действующего file limit отклонено понятной причиной |
| P09 | Existing config/state upgrade | Access/device token, sources, interval и enabled state сохраняются; migration идемпотентна |
| P10 | Crash/update/lost publication reply | Status query и per-file resume, нет duplicate version/effect или потери snapshot |
| P11 | Другой device/root/revoked token | Изоляция и revoke работают; нет доступа к Windows deletes/moves |
| P12 | Одновременная работа с Windows и другими writes | Общие бюджеты, fairness и backpressure; throughput считать по published, не ingress |

### 6.3 Наборы и численные цели

| Набор | Состав | Основная проверка |
|---|---|---|
| D1 | 1700 файлов около 444 MB | Сопоставимая initial/repeat нагрузка, native Windows и Pluto где типы поддерживаются |
| D2 | 100k файлов 1–64 KiB | HTTP/SQL/SFTP amplification и small-file batches |
| D3 | 395k файлов + 68k dirs, синтетическая форма дерева | Initial pipeline, resume, RAM и namespace completeness |
| D4 | 500k и 1m total objects | Нет root-limit и линейного RAM роста |
| D5 | 100k siblings, отдельная глубина 200 | Indexed lookup, paging и depth capability; unsupported depth явно диагностируется, а не теряется |
| D6 | 256 MiB, 4 GiB, 40 GiB и изменяемые поколения | Neptune resume/source capture/delta; Pluto испытывается только в действующем лимите |
| D7/D8 | Unicode/collisions/links/empty files и непрерывные изменения | Политики имён/источников, generations и fairness |
| D9 | Windows + Pluto + Drop/backup одновременно | Global storage budgets, изоляция, recovery и отсутствие starvation |

На объявленном здоровом SSD-стенде: empty-cycle p95 <=2 s после получения сигнала, без long-poll wait; edit-to-publish малого стабильного файла p95 <=5 s; первый readied file p95 <=5 s при готовых родителях/ресурсах. Engine working set цель <=384 MiB на 500k objects, рост 100k→500k <=64 MiB после стабилизации cache. На metadata-bound наборе цель >=3× end-to-end относительно исходного алгоритма при той же проверке целостности. Это критерии стенда, не обещание времени на неизвестном production SFTP. Измеренный физический предел не отменяет структурные условия A02 и устранения повторов.

## 7. Полное покрытие предложений исходной спецификации

| ID | Реализация/применение | Этапы | Особенности Pluto |
|---|---|---|---|
| S01 | L/B/R, generations, baseline | 03/06/07 | Backup baseline, без infer-delete |
| S02 | Streaming scanner + snapshot import | 04/05 | Сохраняемый source scan, общий server index |
| S03 | Local delta, journal/gap handling | 06 | inotify + restart reconciliation, без обещания USN |
| S04 | Commit-ordered remote feed | 04/06 | События своего scope, не глобальный каталог |
| S05 | Durable dependencies/operations/receipts | 03/04/05 | Resume отдельных copies и versions |
| S06 | Indexed lookup, batch metadata, IDs | 02/04/05 | Общий server resolver, собственный persistent parent cache |
| S07 | Small-file batches/per-item outcomes | 08 | Config files отдельно в backup policy |
| S08 | Stable source capture/hash pipeline | 03/08 | Сохранить verified snapshot и link-target safety |
| S09 | Global budgets/adaptive scheduling | 05/08 | Делит server budget с Windows, свои client limits |
| S10 | Recoverable publication/verification | 04/08/09 | Versions/retention подтверждаются тем же commit core |
| S11 | IDs, moves, CAS, guarded deletes | 07 | CAS updates; Windows MOVE/DELETE не включать |
| S12 | Resumable reconciliation/scrub/Merkle | 04/06/09/10 | Gap recovery; scrub общий на Saturn |
| S13 | Cost-gated block delta | 09 | Backend/capability и действующий max file size |
| S14 | Authorized reuse/clone | 09 | Только разрешённая область и независимые copies |
| T01 | Parent singleflight/bounded cache | 02/05 | Persistent parents + invalidation |
| T02 | One state writer/WAL/batching | 03 | Отдельная transactional SQLite store |
| T03 | Set-based SQL/direct projection | 02/04/05 | Общий Saturn path |
| T04 | HTTP pooling/stream/timeouts | 01/05/08 | Existing Go client расширяется |
| T05 | Measured SFTP request window | 08 | Общий backend, не client SSH credentials |
| T06 | Debounce/generations | 03/06 | Daemon dirty queue |
| T07 | Streaming metadata enumeration | 05 | Filepath/source adapter без whole-tree arrays |
| T08 | Versioned excludes/preview | 07 | Отключение источника сохраняет backups |
| T09 | NameCodec/links/path policies | 01/04/07 | Сохранить отличающуюся link policy |
| T10 | Byte-weighted fairness/aging | 05/08 | Windows+Pluto общей нагрузки |
| T11 | Empty and metadata-only files | 05/08 | Без создания лишней версии контента |
| T12 | Selective metadata/content compression | 08/09 | Общий contract и исходный hash |
| T13 | Classified retry/backoff/breaker | 03/05/08 | Partial source failure не запускает повтор всех copies |
| T14 | Admission/reservations/temp refs | 03/04/08 | Snapshot/spool budget и lease-aware cleanup |
| T15 | Per-root/stage status/error IDs | 00/03/05/06 | TUI/daemon actual published counters |
| T16 | Root/mount/profile identity/ownership | 01/03/06/07 | Source identity, single daemon writer |
| T17 | Explicit active-data capture | 09 | Completed exports/dumps, не unsafe live database copy |
| T18 | Amplification metrics/audit | 00 и все | Сопоставимые формулы без file-label explosion |
| T19 | Durable feed + long-poll hints | 04/06 | Observation schedules сохраняются |
| T20 | Cached materialized UI/status | 01/03/06 | Status socket/TUI не запускают source scan |

## 8. Совместимость и порядок активации

| Клиент | Saturn legacy | Saturn new, feature OFF | Saturn new, root activated |
|---|---|---|---|
| Старый Neptune Windows | Работает по текущему контракту | Поддерживаемый legacy path, не обходит общий publication core | Только если writer/schema/epoch совместимы; иначе понятный отказ |
| Новый Neptune installed/portable | Negotiated legacy fallback, если безопасен | Миграция/plan-only, feature flags OFF | Новый engine, consistent index/feed/receipts |
| Старый Pluto | Текущий backup contract | Сохранены routes, права, limit/retention | Не ломается активацией чужого Windows root; для своего root действуют bounds |
| Новый Pluto | Поддерживаемый fallback со snapshot safety | Migrated state, conservative baseline | Backup delta engine, отдельная policy |
| Neptune Linux/other Saturn clients | Текущие поддерживаемые контракты | Совместимость shared Core и mutation core | Не получают Windows policies автоматически |

Вход в новый режим: validate identities → backup → migrate copy → compatibility tests → isolated canary → source profile migration → adopt/no-delete → activate. Нельзя менять root epoch/codec между двумя одновременно пишущими версиями клиента. Откат optional flags сохраняет базовую схему; бинарный откат требует отдельной совместимой копии и повторного согласования с актуальным сервером.

## 9. Текущее выполнение и доказательства

Исходная локальная когорта сохранена в [source inventory](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/source-inventory.json). Ранее существовавшие изменения: Neptune 3 tracked modified files, Saturn 19 tracked modified files и 3 untracked материала, Pluto 1 tracked modified file. Исходные patches сохранены отдельно от будущих patches программы.

PERF-00 начат: тестовый PostgreSQL выделен в отдельный контейнер с собственной ownership label, local-only port и ресурсными лимитами. PERF-02 начат с узкой оптимизации общего child lookup. Принятие полных этапов остаётся открытым до их функциональных, performance, interaction и migration gates.

Первый параллельный блок прошёл адресные проверки: общий indexed lookup, Neptune bounded parents, Pluto bounded transfer pipeline и MSI/ZIP из общего publish. Реальные Core/Copy engines прошли совместный HTTP/PG smoke с SHA-256 read-back и повтором без content upload. Второй блок добавил проверенные inactive SQLite state/migration обоих клиентов и readonly ID metadata contract Saturn; совместные HTTP/local/SFTP проверки также прошли. Это приёмка конкретных инкрементов, не всех этапов.

Третий блок: Neptune scanner foundation прошла 27 новых тестов и общий Core 210/210; synthetic 100k/500k удерживает RSS около 73 MiB. Обнаруженное неограниченное продвижение wide parent и удаление старого generation исправляется отдельным T02 increment; scanner пока не подключён к реальным загрузкам. Saturn inactive journal foundation прошла 100 concurrent transactions, три читателя, 607 synthetic metadata events, replay/rollback/timeout/epoch/bigint и additive migration; logical backup/recovery, writer coverage и feed остаются открытыми. Pluto advisory planner и его bounded индекс проверяются отдельно. Новый delta engine пока не активирован.

Фактические результаты и непрошедшие gates записываются в [матрицу выполнения](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_ACCEPTANCE_MATRIX.md). Планируемые проверки из этого документа не считаются уже выполненными.
