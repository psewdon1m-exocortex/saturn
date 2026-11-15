# Передача реализации оптимизации синхронизации: Saturn, Neptune Windows, Pluto

> **Работа возобновлена 13 октября 2026 по новому указанию оператора:** повторная проверка выполненного, завершение незавершённой реализации и тестирование. **Шестичасовой прогон запрещён до отдельного явного указания.** Основной текст ниже сохраняет исторический снимок передачи; новые результаты добавлены в конце и в [журнале текущей работы](C:/.projects/exocortex/.history/2026-10-13-sync-implementation-revalidation.md). Итоговая готовность ещё не подтверждена.

**Состояние передачи: работа приостановлена по просьбе пользователя 13 октября 2026.** Этот документ предназначен программисту или новому оркестратору, который продолжит задачу в другом чате. Он описывает сделанное за 12–13 октября, сохранённые ошибки, незавершённые изменения и порядок дальнейшей работы.

Последняя проверка остановленного состояния: **13 октября 2026, 09:40:59 UTC / 12:40:59 Europe/Istanbul**. После неё выполнялась только подготовка и проверка этой документации. Актуальные identities процессов и ресурсов при последующем возобновлении проверяются заново.

**Шестичасовой стресс-прогон новой системы ещё не запускался.** Общая реализация, сквозная приёмка и сравнение производительности не завершены. Production не обновлялся; новая система не объявлена готовой к выпуску. Два агента прерваны, третий завершил задачу дизайна. Активных нагрузочных клиентских прогонов при передаче нет. Сохранены пассивные тестовые серверы и данные для продолжения диагностики.

## 1. Как пользоваться этим документом

Сначала прочитайте разделы 2–4: они объясняют цель, текущий результат и правила работы с состоянием. Затем разделы 8–11: там находятся конкретные незавершённые задачи. Раздел 15 задаёт порядок продолжения и критерии, по которым можно принять каждый следующий результат. **Правила запуска шестичасового теста находятся в последнем разделе.**

Основные документы:

- [Оригинальная спецификация NEPTUNE_SATURN_SYNC_PERFORMANCE_SPEC_v1.0.md](C:/.projects/exocortex/saturn/docs/NEPTUNE_SATURN_SYNC_PERFORMANCE_SPEC_v1.0.md): исходные решения S01–S14, T01–T20, сценарии A01–A42 и целевые показатели.
- [Матрица принятия работ](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_ACCEPTANCE_MATRIX.md): критерии этапов PERF-00–PERF-11 и реестр проверенных инкрементов.
- [Поэтапный план реализации](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_IMPLEMENTATION_PLAN_v1.0.md): зависимость этапов, проекты, область миграций и выпуск Windows.
- [План шестичасовой приёмки](C:/.projects/exocortex/saturn/docs/implementation/SYNC_RELIABILITY_6H_ACCEPTANCE_PLAN.md): требования к итоговой кампании.
- [Полный прежний журнал, сохранённый перед переупаковкой](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/handoff-paused-2026-10-13/report-history/IMPLEMENTATION_HANDOFF_2026-10-13.before-final-handoff.md): хронология, промежуточные результаты, дополнительные hashes и подробности предыдущих попыток. Сохранён без изменений: 65 232 байта, SHA-256 `f37c8665a1f6914b05fffef4a6010e6dd583f924e488cc933dc42314921d8d01`.
- [Снимок Git-состояния при передаче](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/handoff-paused-2026-10-13/live-git-status.json), [входные документы и их hashes](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/handoff-paused-2026-10-13/document-inputs.json), [файлы незавершённых областей](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/handoff-paused-2026-10-13/unfinished-area-inputs.json).
- [Подтверждённое состояние паузы и retained resources](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/handoff-paused-2026-10-13/handoff-paused-state.json), [точные hashes незавершённого live Core и Windows bridge](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/handoff-paused-2026-10-13/live-unfinished-source-hashes.json).

Основной каталог доказательств далее называется **AUDIT**:

`C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z`.

Каталог инструментов будущего теста далее называется **ENDURANCE**:

`AUDIT/endurance-6h`.

Матрица и план содержат исторические оперативные записи. Например, в некоторых строках stage3 ещё «в работе», а оригинальный Pluto R1g ещё «не запускался». **Актуальный статус этих конкретных случаев изложен ниже; прежние PASS/FAIL сохраняют значение только для указанных в них сборок.** Новому исполнителю нужно обновлять матрицу после независимой приёмки, сохраняя ссылки на прежние результаты.

### Что означают статусы

| Обозначение | Практическое значение |
|---|---|
| Принято ограниченно / PASS limited | Конкретная зафиксированная сборка прошла перечисленные проверки. Всё, что находится за пределами перечисленного покрытия, остаётся открытым. |
| Проверено агентом, ждёт интегратора | Код и результаты подготовлены, но независимая проверка исходников, binaries, сохранности чужих правок и общей композиции ещё не закончена. |
| Черновая реализация | В живом проекте уже есть изменения и частичные тесты. Их нельзя выдавать за принятый релизный payload. |
| Только дизайн | Описано решение и критерии. Реализации либо миграции ещё нет. |
| FAIL retained | Отказ сохранён вместе с исходным состоянием. Его нельзя убрать из отчёта созданием нового пустого профиля. |
| UNVERIFIED | Нужная проверка реально не проведена. Build или fixture не заменяет её. |

## 2. Зачем понадобилась эта программа

Пользователь наблюдал примерно 12 часов первоначальной синхронизации каталога `C:/.projects` размером 154 GB: около 395 731 файла и 68 419 каталогов. На сервере число каталогов росло, один каталог создавался примерно раз в 3 секунды, а загрузка файлов казалась последовательной. На втором ПК около 1700 файлов / 444 MB первоначально синхронизировались примерно за 30 минут, повторные проверки занимали около 10 минут; дважды появлялось общее сообщение `synchronization failed` без подробностей.

Это пользовательские наблюдения, а не лабораторные измерения конкретной версии. Из них нельзя восстановить точную причину двух ошибок на другом ПК. При темпе один каталог / 3 s только 68 419 каталогов занимают около 57 часов, если этот темп сохраняется; это иллюстрация стоимости пообъектных round trips, а не обещание оставшегося времени.

Исходные архитектурные проблемы, подтверждённые анализом кода, были шире количества потоков:

1. Подготовка родителей повторялась для разных файлов, поиск имён мог ходить по страницам children.
2. Первоначальный обход и подготовка дерева тормозили первый полезный upload; часть путей материализовала дерево в памяти.
3. Повторная синхронизация снова проверяла множество неизменённых объектов и серверных ETag.
4. Не хватало общей долговечной модели согласованного состояния, поэтому обход и повторные запросы заменяли знание уже выполненных операций.
5. На server/backend требовалось согласовать приём bytes, проверку, физическую публикацию, catalog и journal. Простое увеличение concurrency обнаруживало проблемы координации.

**Целевой подход — вычислять и передавать изменение относительно последнего подтверждённого состояния.** Первоначальная загрузка становится ограниченным конвейером с сохранёнными зависимостями родителей; повторная работа — обработкой адресных локальных изменений и серверного журнала. Если наблюдение неполное, запускается явная возобновляемая сверка с сохранением истории. Потоки ограничиваются независимо по metadata, content, CPU, bytes, RAM и диску.

Большую production-синхронизацию пользователь сам поставил на паузу. Эта работа не возобновляет её и не меняет её профиль. Решение о переходе реального большого mapping допустимо после проверки миграции и сквозной работы.

## 3. Область проекта и что затрагивается

| Проект / компонент | Уже затронуто | Что ещё потребуется |
|---|---|---|
| **Neptune.Core** | SQLite state/migrations, L/B/R, immutable operations, bounded scanner/queues, parent preparation, contracts/HTTP, snapshot/feed, resume, NTFS/USN и generations | Завершить JournalGap replacement, интеграцию новой повторной синхронизации, полноценные resource/performance gates и общий upgrade |
| **Neptune.Windows** | Guarded mapping session, profile/DPAPI/enrollment compatibility, retained resume; общая сборка MSI/portable | Подключить явно принятый IdentityOnly + parent reconciliation к обычному Windows service, закончить native eligibility и HTTPS interop, UI/status, final payload |
| **Neptune release/packaging** | Один WPF publish как источник MSI и ZIP; manifests/verifiers/update guards | Пересборка после final Core; native installation/update/autostart/uninstall и реальный workflow остаются непроверенными |
| **Saturn** | sync/file-core/database/contracts/storage; indexed lookup; capabilities; journal/snapshot/feed; upload/folder receipts; migrations до 0058; normal API/worker; backup/recovery и admission | Независимо принять fair admission; безопасно восстановить старый заполненный QUALIFYING fixture; all-writer coverage, migration/rollback, metadata/batch/adaptive решения |
| **Pluto** | Go persistent state/migrations/scanner/transfer/HTTP; cursor recovery; original operation resume; source ownership/remount; CLI/release/updater compatibility | Завершить original recovery/current authority, интеграцию repeat и bounded scheduler, measured no-change, общий daemon/TUI gate |
| **Kernel** | В текущем живом репозитории изменений не обнаружено | Может потребоваться согласование discovery/capabilities и Outdoor preset allowlist. В стенде это fixture; реальный Kernel не участвует |
| **Updater** | Отдельный живой проект не изменён; Pluto updater/release проверялся в своём проекте | Общий порядок обновления API/worker/schema/clients, health/rollback при новой топологии |
| **Mastermind** | Отдельный живой проект не изменён | Возможное владение генерацией Unicode codec tables; runtime менять только при действительной зависимости |
| **Gryphon** | Отдельный живой проект не изменён | Проверка совместимости уведомлений при новых статусах, без изменения алгоритма передачи |

Portable и standalone — **две упаковки одного Windows приложения**, а не две отдельные реализации. Нельзя завести второй sync engine и затем исправлять два проекта независимо. Установленная версия остаётся основной продуктовой целью; отсутствие VM не отменяет её критерии приёмки.

Neptune сохраняет `upload_mirror_guarded`: серверные независимые изменения дают конфликт, а не безусловную перезапись или скачивание. Pluto сохраняет backup-семантику: исчезнувший источник не удаляет серверную копию; ограничение файла 256 MiB и максимум 10 активных версий не расширяются этой оптимизацией.

## 4. Основные правила корректности — объяснение для нового исполнителя

### 4.1. L/B/R и dirty generations

- **L** — наблюдаемое локальное состояние.
- **R** — квалифицированный серверный снимок и последующие изменения.
- **B** — последний доказанный общий baseline: какая конкретная версия была согласована с обеих сторон.

Если L и R соответствуют B, содержимое не нужно повторно передавать. Если изменилось только L — планируется условная публикация. Если изменилось R либо обе стороны — применяются правила конфликта. Отсутствие достоверного L или R не разрешает вывод «всё одинаково».

У локального объекта есть поколение изменений. Если worker начал публикацию поколения `g`, а во время передачи появился `g+1`, завершение старой операции не может очистить новый dirty. Это защищает от потери правки во время upload.

### 4.2. Receipt не равен текущему согласию

Immutable receipt доказывает, что исходная операция с конкретными IDs/input/hash/bytes была опубликована. Он не доказывает, что сегодняшний локальный файл или серверный объект всё ещё равен этой версии.

Поэтому восстановление старых операций и построение нового B — разные шаги. Нельзя перенести исторический receipt в текущий baseline без свежего квалифицированного R, проверки актуальных bytes/identity/topology и условного подтверждения поколения.

### 4.3. Gap и UNKNOWN должны сохраняться

USN gap означает, что часть локальной истории больше недоступна либо не доказана. Remote cursor expiry означает потерю нужного промежутка серверного журнала. Правильный путь — сохранить старые operations/B/seals и построить новый согласованный cut через отдельную процедуру.

`UNKNOWN` — долговечная неопределённость catalog/publication. Видимый файл или совпавший размер не превращает её автоматически в `AVAILABLE`. Нужны происхождение, владение, действующая authority и проверка физического результата.

### 4.4. Cohort и «принятый код»

Когорта — зафиксированная комбинация исходников, зависимостей, binaries, runtime policy и доказательств. Число проверок независимого review — число проверенных pins/invariants; оно **не** равно числу продуктовых сценариев.

В живых репозиториях смешаны ранее существовавшие пользовательские изменения, принятые инкременты и последний незавершённый JournalGap draft. Поэтому current working tree не равен одной уже принятой сборке. Для каждой новой проверки фиксируйте свою композицию и указывайте, какие предыдущие результаты переносимы.

## 5. Карта готовности этапов

Для чтения технических записей ниже:

| Термин | Простое объяснение |
|---|---|
| Authority / full binding | Проверенная привязка к конкретным server/root/device/backend/epoch и разрешённому режиму. Совпадения URL недостаточно |
| CAS | Условная запись: выполнить изменение только если ожидаемая версия, поколение или состояние всё ещё совпадает |
| Cut / cursor | Согласованная граница наблюдения и позиция в журнале, от которой можно безопасно продолжить чтение |
| Seal / spool | Неизменяемые байты конкретной передаваемой версии и их локальное долговременное хранение для повтора |
| WAL | Журнал SQLite, в котором могут находиться уже подтверждённые изменения, ещё не перенесённые в основной файл базы |
| Fixture | Изолированный заменитель/стендовый компонент. Его успех не доказывает поведение настоящего Kernel, установщика или WPF |
| Owned / protected | Файлы и ресурсы, которыми владеет этот инкремент, и исходные области, которые он обязан сохранить |
| Exact reverse | Проверка, что обратный patch восстанавливает исходные файлы и удаляет только собственные добавления |
| PDB closure | Проверка фактических compiler inputs: какие именно исходники вошли в проверяемый .NET binary |
| Admission / backpressure | Допуск новой работы в пределах ресурсов и прекращение нового capture/запуска, когда очередь или бюджет заполнены |

Полные условия находятся в [матрице](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_ACCEPTANCE_MATRIX.md). Ни один приведённый ниже частичный PASS не закрывает автоматически весь этап.

| Этап | Реальное состояние передачи | Основное незакрытое условие |
|---|---|---|
| PERF-00 — измерительный стенд | B0 D1 измерен для обоих старых engines; identities/dataset/requests/CPU/RSS/SHA сохранены | Завершённый matched N0, несколько повторов, D2/D3/D4/native scale, сопоставимые условия |
| PERF-01 — единый Windows bundle | Common publish → MSI + ZIP реализован и проверялся локально | Final Core/package; MSI install/update/autostart/UX, native profile migration и workflow |
| PERF-02 — родители / indexed lookup | Ограниченные parent caches/singleflight и indexed exact lookup приняты отдельно | Полное persistent ID/epoch поведение и benchmark на конечном backend |
| PERF-03 — постоянное состояние | L/B/R/dirty/original operations/migrations/resume приняты ограниченными когортами | Current JournalGap draft, сквозной upgrade, активный planner и rollback |
| PERF-04 — серверный протокол | Receipts, snapshot/feed, coherent backup и fresh empty ACTIVE runtime приняты ограниченно; fair admission проверен агентом | Root review fair admission; заполненные roots; all writers; coordinated backend recovery |
| PERF-05 — initial pipeline | Bounded scan/queues и opt-in streaming executor, ранние small native публикации | Полный D1/D2 initial через обычный Windows service; ресурсные бюджеты всей композиции |
| PERF-06 — delta repeat | Реальный NTFS/USN, staged R, same-scope repeat foundations; stage3 принят | Default/UI activation; gap reconciliation; ordinary fresh/K10/no-change и performance gates |
| PERF-07 — namespace/conflicts | Основания identity/CAS/codec есть; безопасные отказы проверялись | Полные moves/deletes/rename cases, versioned excludes и политики |
| PERF-08 — batches/adaptation | Есть sealing и fixed bounds, но полный этап не принят | Small-file protocol, one-pass pipeline, adaptive budgets, mixed fairness |
| PERF-09 — backend acceleration | Не завершён | Опциональные delta/dedupe/Merkle/capability paths с явным fallback |
| PERF-10 — end-to-end migration | Отдельные миграции проверены; original states сохраняются | Общая последовательность обновления, populated-root repair, продолжение originals, rollback |
| PERF-11 — итоговая приёмка | Не начата как завершённая кампания | Final common gates, final payload, matched performance и один 6h stress |

### 5.1. Соответствие системным решениям S01–S14

| Решение | Что уже есть | Что нельзя считать завершённым |
|---|---|---|
| S01 — L/B/R | Постоянные модели обоих клиентов, generations, baseline/history invariants | Общий активный fast path Windows/Pluto и adoption заполненных mappings |
| S02 — streaming initial / snapshot | Bounded enumeration и executor; qualified snapshots/feed; ранняя small native публикация | Большой initial, first-upload target и final service integration |
| S03 — USN / адресные события | Stage1–3, native cuts, parent reconciliation, same-scope restart | Explicit JournalGap replacement; обычный Windows activation; native 500k coverage |
| S04 — commit-ordered server journal | SQL clocks/events, snapshot/feed, backup, receipts | Все серверные writers, populated-root transition/takeover и полный rollback |
| S05 — durable DAG / idempotency | Parents/work dependencies, original IDs/sealed bytes, bounded resume | Все fault combinations и mixed-client activation |
| S06 — metadata / IDs / index | Exact indexed getChild, readonly batches, bounded caches | Полная batch publication/ID invalidation и большие measured gains |
| S07 — small-file batches | Полного product path нет | Per-item results, byte/admission limits, lost-reply/replay и partial failure |
| S08 — pipeline hash / exact version | Immutable source capture/hash и проверка переданного результата | Общий one-pass efficiency path без дополнительных проходов при сохранении гарантий |
| S09 — adaptive scheduler | Fixed independent bounds и audit resource admission | Адаптивная регулировка, ресурсный controller продукта, общая fairness |
| S10 — receive/write/verify/publish | Исторические receipts, qualified CAS; SFTP semantic handling; fair admission successor | Полное distributed coordination, UNKNOWN repair и all writers |
| S11 — identity/moves/deletes | Native identity, conditional changes/conflicts, отказ от опасных deletes | Полный remote move/rename/delete protocol и 20k rename gate |
| S12 — resumable reconciliation/scrub | Bounded snapshot/feed/rebootstrap и recovery foundations | Полная сверка больших деревьев; Merkle при оправданной экономике; отдельный scrub |
| S13 — block delta | Не реализован как принятый ускоренный path | Capability-gated экономическая оценка, block hashes, fallback и integrity |
| S14 — whole-file reuse | Не реализован как принятый ускоренный path | Authorized server reuse без cross-user oracle, правильные receipts/version semantics |

### 5.2. Соответствие точечным решениям T01–T20

| Решение | Текущее покрытие / следующий шаг |
|---|---|
| T01 — parent single-flight/cache | Реализовано ограниченно для обоих клиентов; продолжить с persistent IDs и epoch invalidation |
| T02 — SQLite single writer/WAL | Bounded transactions, migrations, WAL-aware backups/quotas и held-WAL refusal проверялись; final draft и global resource gate открыты |
| T03 — SQL N+1/index/projections | Indexed lookup и EXPLAIN на 100k; требуются полные metadata amplification measurements |
| T04 — HTTP pool/stream/timeouts | Streaming/bounds/strict transport foundations; окончательная ordinary HTTPS service composition ещё открыта |
| T05 — SFTP request window | Исправлено ошибочное retirement healthy lease после квалифицированного semantic status; системный window tuning ещё предстоит |
| T06 — debounce/generations | Conditional dirty generations и адресные изменения есть; максимальное ожидание/UI orchestration проверить сквозным K10 |
| T07 — bounded enumeration | Persistent/bounded scanning принято отдельно; native 500k initial throughput/RSS не доказан |
| T08 — versioned excludes | Не завершено; исключение может изменить effective namespace и требует миграционной политики |
| T09 — names/case/links/NTFS | Strict cross-language wire/name vectors и fail-closed cases; полноценные namespace transformations остаются |
| T10 — byte/time fairness | Local root publication FIFO принят агентом; общая fairness больших/малых content jobs ещё не доказана |
| T11 — zero/meta-only | Нулевые файлы включены в D1; полный zero-content и metadata-only fast path требует отдельного gate |
| T12 — compression | Не принято как полноценный оптимизированный product path |
| T13 — typed retry/backoff | Bounded typed retry/cursor recovery/429 и original identity; полный Retry-After/circuit-breaker matrix ещё открыт |
| T14 — byte/disk/temp admission | Fixed spool/buffer limits, bounded captures, test disk policy; общий lifecycle budget всех процессов ещё квалифицировать |
| T15 — mapping/phase status | Есть counters/typed diagnostics; полное объяснимое Windows UI/status без общего Storage счётчика не завершено |
| T16 — root identity/single owner | Native proof/locks/profile/root/config fences и source remount; whole-profile replacement/bridge gate ещё открыт |
| T17 — active-data capture | Writer-defer/sealed snapshots проверялись; большие active DB/VM/VSS профили не квалифицированы |
| T18 — amplification/metrics | Raw timings/requests/bytes/CPU/RSS/cohort evidence есть; нужен единый before/after/per-phase итог |
| T19 — long-poll as hint | Не завершено; уведомление должно только инициировать чтение надёжного feed, не заменять его |
| T20 — cheap UI/status | O(1) totals и bounded retirement есть; UI/shell path без обхода нужно подтвердить отдельно |

Спецификация включает также A01–A42. Не следует принимать их по этой обзорной таблице: переносите точные условия из `11.3 спецификации в сценарии и строки матрицы. Особо важны initial, no-change, K10, new deep file, single-flight, rename, g+1, server conflict, lost ACK, gaps, ownership, migration/rollback и bounded resources.

## 6. Что выполнено в Saturn

### 6.1. Поиск, метаданные, transport и общие контракты

- Переиспользован indexed exact child lookup вместо повторного поиска имени через страницы children. Сохранены legacy name semantics; SQL plan проверялся на 100k в откатываемой транзакции.
- Подготовлены readonly metadata batches/capabilities и строгие TS/C#/Go contracts. Golden vectors включают тысячи случаев; malformed/prototype/Unicode/name/authority ответы не должны незаметно менять режим клиента.
- Исправлена SFTP lease policy: квалифицированный `NO_SUCH_FILE` и другие semantic statuses не уничтожают исправный transport. Timeout/disconnect/повреждение транспорта по-прежнему требуют retirement.
- Малый парный mixed fixture после этой правки дал Neptune 32 079 → 3766 ms и Pluto 32 764 → 4702 ms, все 66 backend SHA-256 совпали. Это один искусственно задержанный стендовый sample, **не** доказательство такого ускорения больших production данных.

Конкретные ранние когорты и raw checks находятся в [реестре матрицы](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_ACCEPTANCE_MATRIX.md) и сохранённом полном журнале. Перечисленные результаты не отменяют необходимость конечного backend measurement.

### 6.2. Catalog, journal, receipts, backup и guarded recovery

Созданы durable journal/catalog операции, commit ordering и capability/authority/CAS fences. Coherent logical backup читает dump и bounded JSONL из одного PG cut, сохраняет clocks/events/receipts и upload dependencies. Registered-root restore не активируется автоматически без backend reconciliation.

Исторический upload result хранится как immutable receipt, а не строится повторно из mutable текущей версии файла. Lost SQL/HTTP ACK восстанавливается тем же idempotency key. Видимый physical result не позволяет обходить UNKNOWN и authority checks.

0057 разрешает fresh journal read при **строго private transport**, не имеющем public claim/result/event. UNKNOWN, чужая binding и unsafe public mutation остаются блокирующими. Это limited QUALIFYING capsule, не обычный production ACTIVE server.

Original fixture был дополнительно мигрирован 56→57 с actual coherent dump/pg_restore-list и сохранением ledger/device/token/full binding/port. Он остался диагностическим QUALIFYING fixture; обновление само по себе не доказало продолжение клиентов.

### 6.3. Принятый normal runtime 0058 — ограничение важно

[Когорта guarded-runtime-active-0058](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/guarded-runtime-active-0058/cohort.json), SHA-256 `655d82d022afb00585ecf084d4ad3fcce6d4ec9573c07a8b32af0c3cff605d46`.

[Независимый review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-active-0058-review.json): 2511 проверок; 28 owned / 406 protected, 303 runtime source / 472 emitted files. 266 unit tests в 39 файлах плюс отдельные PostgreSQL/local/SFTP/HTTP/DAV/backup checks; группы пересекаются.

Приняты обычные main API и worker для **свежих пустых ACTIVE roots**, с покрытием `append-only-directories/file-cas`. Проверялись folder-v2, direct ROOT/SYNC/OUTDOOR, historical replay, lost ACK, foreign collision→UNKNOWN, current authorization, types/lint. Исправлено starvation от 100 повторов complete одной операции.

Не приняты автоматически: заполненные старые roots, весь набор move/delete/trash/purge/import/recovery writers, distributed takeover, полный backend switch. Не расширяйте объявленное coverage ради прохождения теста.

### 6.4. Ordinary template и жизненный цикл процессов

[Fresh ordinary template review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-fresh-ordinary-template-review.json): 623 проверки, SHA когорты `58c528236c7ed7a7f0136df872549c67c92830b6ef6649ff69df8330080b4c59`. Два fresh UUID, migrations58, два разных клиента, initially empty ACTIVE roots, snapshots/feed, normal main API/worker, authenticated DAV SHA/Range206/peer404. Собственные четыре containers/volumes удалены. Frozen template сохраняет прежний порог 40 GiB; менять принятый snapshot молча нельзя.

[Ordinary Windows Job lifecycle review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-ordinary-job-lifecycle-review.json): 1120 проверок, SHA `e1a829287e995883f588859e96a002ecfcfd804860849e7c89e839264f9e5465`. API/worker/Gateway работают в собственном non-breakaway Windows Job с kill-on-close; два actual positive ~70 s и три negative wrapper cases. Identity/join/cleanup проверены отдельно от клиентской нагрузки.

### 6.5. Последняя правка fair admission — root ещё не принял

[Acceptance агента](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/catalog-runtime-fair-admission/acceptance.md), [cohort](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/catalog-runtime-fair-admission/cohort.json).

Когорта `755c2638-8207-4bf2-b5e7-25f699e5713e`, SHA-256 `00bd17630dd79d4a53dd19be560da9026673a284d6a4a13f05768a7810e03708`. Frozen ordinary runtime `ordinary-server-65fb06d6-db6d-42b5-a6b6-cd51fac50336`, freeze SHA `f77c95e532945846b2af3468d50d3060ea0a3e5af71d28bd48a1e18c9554a9a5`, 304 source / 474 emitted files.

**Причина:** folder publication и file verify одного root могли перекрыться. Установленная SQL 0058 правильно отказывала на строке 69 при наличии конфликтующего journal operation, но процессы одного FileService сами создавали такой overlap.

**Исправление:** trusted runtime передаёт folder/file paths общую bounded FIFO по `sync_root_id`. Folder удерживает slot от reserve через physical publication до commit/UNKNOWN. File hashing/MIME и private transfer остаются вне длинного publication slot; короткие SQL reserve/chunk/progress/cancel используют короткое admission. Complete входит после hash/MIME и удерживает slot до terminal handling. Исторический accepted result/status не голодает из-за очереди.

Пределы: максимум 16 root keys, 16 ожидающих calls/root, 64 суммарно, ожидание до 10 s, cancel/abort/close очищают очередь; admitted writer удерживает slot до конца. Четыре private content stream slots независимы.

Изменены семь owned sources:

- `saturn/packages/file-core/src/catalog-root-admission.ts` и его test;
- `catalog-folder-v2-transfer.ts`, `catalog-upload-transfer.ts`, `file.service.ts`;
- `saturn/packages/sync/src/guarded-runtime.ts`;
- `saturn/apps/api/src/catalog-runtime-fair-admission.integration.test.ts`.

SQL migrations/0058 functions, wire/binding/receipt contract не менялись. Это **process-local coordination**, не распределённая lease: другой runtime или UNKNOWN всё ещё получает безопасный SQL отказ.

Проверки агента: actual PG predecessor RED55000; final local 10 групп и SFTP ordinary 11 групп; реальные normal API/worker без DI overrides; 6 files / 12 overlapping directories / 3 authenticated DAV SHA; 306 unit tests в 42 файлах без skip; 5 legacy PG, 4 CJ04/limit, 1 folder-v2; types/lint. 496 protected current files и exact reverse сохранены. Worker exit0 записан; API exit-code не записан — его нельзя объявлять 0 по факту отсутствия PID.

**Следующий шаг:** независимый root review source/binary/evidence/protected closure, затем новый runtime-only handoff отдельной когорты. Original 73267441 ещё не переведён на эту сборку и не повторялся. Raw first SQL stderr содержит чувствительные параметры под ограниченным DACL; его нельзя публиковать в открытом отчёте.

## 7. Что выполнено в Neptune

### 7.1. State, initial pipeline, backpressure и retained resume

Добавлены persistent SQLite L/B/R, generations/dirty/cursors/immutable operations, migrations, bounded scan/queue/spool и parent single-flight/cache. Opt-in streaming executor позволяет передавать готовые files после подготовки необходимых parents вместо ожидания всего дерева.

Исследованный caller-context scheduling stall был воспроизведён и исправлен. Common local/SFTP smoke использовал frozen Core/Copy и backend SHA. Эти малые проверки не заменяют full native initial/repeat.

Backpressure successor ограничивает новый capture и число новых bytes; retained spools не исчезают из-за снижения нового лимита. Explicit429 повторяется конечное число раз с исходным key; unresolved прекращает новый capture.

[Retained resume review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-neptune-cycle-resume-review.json): SHA `1a363…` в полном реестре; 1119 independent checks / 390 PDB comparisons, 69 native / 846 full Core PASS. Same scope/B сохраняется после нового PID. O(1) итоговые counters и bounded retirement не делают full SUM/reset по всем mappings; g+1/history/spool/uncertain остаются. Неполный initial anchor безопасно отказывает.

[Remote cursor successor review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-neptune-cursor-review.json): accepted cohort d7bdff…; typed READ410 `cursor_expired` /409 `journal_gap` разрешают максимум два новых staged R при той же authority. Snapshot identity durable до RPC; старые B/originals не уничтожаются. Этот review подтверждает только зафиксированную когорту, а не последующие live edits.

### 7.2. NTFS / IdentityOnly stage1 и stage2

[Stage1 review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-neptune-usn-stage1-review.json): cohort SHA `a501…`, 1032 independent / 395 PDB / 32 targeted / 912 full, zero skips, WPF build0. Native IdentityOnly reader, journal/aliases/OpenFileById/sealed17B. Optional source module1→2 имеет WAL-aware backup; actual old reader отказывает, сохраняя DB/WAL. Legacy Named default не изменён.

[Stage2 review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-neptune-usn-stage2-review.json): SHA `97404278eefdccd70635b6a95b0b9abe80dd1513a21fb9a2b06f507325932301`; 1011 independent / 316 PDB / 39 targeted / 919 full, zero skips. Реальный native synthetic medium token RID8192/Elevation0/AdminDenyOnly. Initial2 files/3 dirs, fresh и same-scope restart с zero captures/enumeration, K1, lost-complete с исходными keys/bytes, writer-defer. Неизвестная nameless creation ещё отказывала; это закрыл отдельный stage3.

Synthetic medium не является доказательством установки и запуска обычного пользователя на независимой машине.

### 7.3. Stage3 принят: новые каталоги без полного повторного обхода

[Когорта](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/neptune-unprivileged-journal-stage3/cohort.json):

`neptune-unprivileged-journal-stage3-83b6d5ad-0eb7-4013-94fa-6db64b185561`,

SHA-256 `3eea6546c5eceec02608ba2efb809aef58eef86a4a78d74e27fb1bcd4e0c815c`.

[Root review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-neptune-usn-stage3-review.json): PASS1612; [PDB review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-neptune-usn-stage3-pdb.json): PASS695. 21 owned / 197 protected / 218 inputs, 88 Core files; exact reverse проверен. 63 targeted и 941 full Core без skips, WPF/runner builds без warnings/errors.

Механизм включается **явно** options-first через IdentityOnly + parent reconciliation. Он перечитывает затронутых parents и новые subtrees ограниченными порциями, а не весь mapping. Dual native pass и реальный journal prefix `[S,D)` дают согласованное membership; candidate/plan/version pointer durable. Staging/frontier/refill максимум 256, retire максимум128.

Known rename/missing/replacement даёт явный conflict. Неполные rename halves, неоднозначные hardlinks/case и journal/root gaps fail closed. Speculative remote delete не выполняется. Historical/unresolved evidence и g+1 сохраняются.

Native новый PID20064→17840 продолжил тот же plan/scope `e765b52bf0964bfd81d3899511293ecc`; new file обработан, затем fresh cycle не делает новых captures/enumeration. Optional cycle format3→4 имеет coherent WAL-aware backup; actual old compiled3 отказал до writes при held WAL без изменения hashes. Два защищённых теста изменили только ожидаемый номер current format3→4, остальная логика сохранена.

Resource proof: structural500k DB270 114 816 B + WAL4 367 232 B + backup1 564 672 B; setup7.783 s, восемь retire-порций по128 за142.3 ms, RSS95.3 MB. На100k pinned WAL65 030 112 B ниже64MiB cap; следующий reserve отказал без сдвига cursor/rows; после release/checkpoint retirement143.9 ms, RSS92.87 MB.

**Пределы:** это structural resource proof, не полный native500k upload/retirement benchmark. В raw resource TRX один100k harness lock FAIL сохранён, исправленный pinned TRX отдельно PASS. Native child полного test suite имел Normal priority при BelowNormal dotnet; affinity15/.NET2 сохранились. Нельзя по этому run заявлять соблюдение priority всех descendants или считать его efficiency sample.

Qualification runner DLL SHA `a9bb4f9bcedf6d5aca5925fb3425ff0276c5052d5a5b41f7a313f8670811533f`; accepted Core SHA `21b9dadc83ce2961c5c00f58a7dd2d61cbf039268957343e885fab32c7134718`. Legacy Named/default/store-first вызовы не включены автоматически. Default Windows bridge, Saturn interop и original JournalGap остаются отдельными задачами.

### 7.4. Windows packaging, profile и bridge

Один final WPF publish является источником MSI и portable ZIP; manifests/verifiers проверяют одинаковый payload. Реализованы installed ZIP guard, profile/native identity, DPAPI/enrollment preservation и release policy tests. Portable не имеет своего отдельного engine.

[Windows retained bridge review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/windows-guarded-resume-bridge/review.json): 759 checks, 40 native, 453 actual PDB, 29 bridge +11 DPAPI/enrollment, builds0warnings. Сохраняются credentials, device/mapping/profile, pause, immutable anchor UUID и old state; modern cycle.db/spool отделены от legacy neptune.db. Современный marker сохраняется до writes. Только квалифицированный premaker404 допускает legacy fallback; malformed/auth/backend отказ не переводит modern профиль молча обратно.

Обычный WindowsSyncService HTTPS path ещё не принят. Попытка CurrentUser certificate-add зависла до запуска клиента/proxy, exact wrapper/job остановлен, trustAdded=false, собственный сертификат после cleanup отсутствовал. LocalMachine trust не добавлялся. Нельзя считать Core HTTP тест доказательством normal HTTPS/WPF или повторять изменение доверия без действующего разрешения.

MSI/ZIP локально собирались, но после final Core нужна новая общая сборка. **MSI install/update/autostart, interactive WPF и native uninstall UNVERIFIED:** пользователь подтвердил отсутствие VM/второго Windows ПК, доступны только этот ПК, WSL2 и Docker. Не запрашивать ту же среду снова без новых обстоятельств и не запускать второй пользовательский агент ради теста.

## 8. Незавершённый Neptune JournalGap replacement

[Дизайн](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/neptune-journal-gap-replacement/design.md). **В живом Core уже есть draft; final cohort/freeze/PDB/root acceptance нет. Исходные D1 profiles этим draft не открывались.**

Задача: безопасно продолжить mapping после недоступной части локального USN journal. Нельзя очистить gap, создать обычный новый профиль и объявить старые операции восстановленными.

### Что уже написано

1. Явный immutable replacement request с исходным UUID/scope/link; exact path/volume/FID/incarnation/principal/config/server authority. Обычный timer не создаёт replacement.
2. Whole-profile OS lock; отдельный verified permit не позволяет generic Rebound переписать исторический gap.
3. Optional cycle4→5 только при явном recovery, с coherent old4 backup. Обычные profiles остаются format4.
4. Historical lane для файлов **и каталогов**, исходные IDs/input/spool/outcomes; никаких synthetic receipts по факту существования папки.
5. Пока replacement не квалифицирован, новые обычные current publications блокируются. New candidate/coherence IDs durable до enumeration; current B разрешён только после реального native cut, свежего qualified R и current equality.
6. Максимум две distinct candidate attempts под одним replacement UUID. Cancelled/incomplete rows очищаются bounded порциями≤128; abrupt BUILDING не превращается в complete.
7. Исторические receipt/work/B/gap сохраняются; g+1 dirty не очищается. Cross-root-key lineage допустим только через сохранённый qualified replacement link.

Основные новые файлы находятся в `neptune/src/Neptune.Core`:

- `LocalJournalReplacementModels.cs`;
- `NeptuneStateStore.CycleReplacementMigration.cs`;
- `NeptuneStateStore.JournalReplacement.cs`;
- `NeptuneStateStore.JournalReplacementOriginals.cs`;
- `NeptuneStateStore.JournalReplacementStages.cs`;
- `WindowsFreshSyncEngine.JournalReplacement.cs`.

Также изменены narrow LocalCycle/Migration/Recovery/Work, WindowsFreshSyncEngine и WindowsLocalCoherenceCoordinator. Новый test `JournalGapReplacementTests.cs`. Точные hashes живых файлов и evidence нужно сверять по переданному снимку и accepted stage3 before inventory; черновик не равен stage3 binary.

### Какие проверки реально завершились до остановки

- [first-green TRX](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/neptune-journal-gap-replacement/first-green-results/first-green.trx):6/6;
- [historical TRX](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/neptune-journal-gap-replacement/historical-results/historical.trx):8/8;
- [directory-green TRX](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/neptune-journal-gap-replacement/directory-green-results/directory-green.trx):9/9;
- [attempts TRX](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/neptune-journal-gap-replacement/attempts-results/attempts.trx):13/13.

Это пересекающиеся subsets; их нельзя сложить как36 уникальных scenarios. Предшествующий qualification-green9 дал8PASS/1FAIL: directory `AdoptedEqual` ошибочно проходил historical parser с null intent. Исправление и новый9/9 сохранены отдельно. Compile CS0136 и raw прежние ошибки также оставлены.

### Что нужно сделать прежде, чем трогать оригинальный D1

- Actual old compiled4 должен отказаться на new5 при **held WAL**, сохранив DB/WAL/backup hashes.
- Новый PID должен продолжить тот же replacement UUID/source/scope и candidate/page continuation; interruption на каждой activation boundary не теряет evidence.
- Подтвердить whole-profile ownership, competing owner, capacity/disk/WAL quotas и bounded retirement.
- Проверить full Core/WPF builds, actual PDB source closure, protected inventory и exact reverse поверх stage3.
- Независимо принять отдельную когорту; проверить real local Saturn authority/HTTP, current equality и g+1.
- Только после этого применять явный replacement к retained original, сохраняя **585/64** либо **429/1** originals. Нельзя начинать с нового initial для сокрытия старого FAIL.

## 9. Windows IdentityOnly/parent bridge — пока только подготовка

[Ownership подготовки](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/windows-identity-parent-bridge/ownership.json).

До остановки сохранены before copies и область владения. **Новая source eligibility реализация ещё не написана; текущий WPF session сохраняет legacy Named default.** Наличие stage3 Core не означает, что обычный установленный клиент уже пользуется им.

План четырёх owned paths:

1. `neptune/src/Neptune.Windows/WindowsGuardedMappingSession.cs`;
2. новый `WindowsGuardedSourceEligibility.cs`;
3. новый `WindowsGuardedNativeEligibilityTests.cs`;
4. additive Compile link в `neptune/tests/Neptune.Core.Tests/Neptune.Core.Tests.csproj`.

Действовать дальше так:

- До anchor HTTP и любых profile effects выполнить native source eligibility публичными `WindowsNativeCycleCapture.OpenAsync`/RootProof и `WindowsUsnJournalReader(volumeGuid, IdentityOnly).QueryAsync`, удержать ancestry handles. Не использовать внутренний Coordinator API из другого assembly.
- Для уже существующего source state проверить bounded readonly active source→root continuity: FID/incarnation/profile/client/mapping/journal/cursor. Gap отказывает до anchor и сохраняется.
- Не перечислять дерево и не создавать/изменять journal ради eligibility. Не требовать privilege, которого нет у обычного пользователя.
- Явно выбрать принятый IdentityOnly + parent reconciliation в guarded session, сохранив DPAPI, fingerprint, credentials, mappings, pause, original anchor UUID/current token. Никакого silent legacy fallback migrated profile.
- Начать с изолированного короткого clone accepted stage3 qualification-final; живой Gap draft нельзя незаметно смешивать в baseline теста. После принятия Gap — отдельная проверка общей final композиции.
- RED→GREEN missing source должен доказать **zero HTTP/profile effects**. Затем actual synthetic medium, real ordinary Saturn HTTP, restart/fresh/K10 и normal service HTTPS.

## 10. Что выполнено в Pluto и почему original ещё FAIL

### 10.1. Принятые основания и R1f

Pluto получил bounded pipeline/parent preparation, streaming enumeration, SQLite L/B/R/original artifacts, dirty generations и staged snapshot/feed, authority/CAS, schema/release/updater checks. Default `EngineReady=false` и legacy Copy/Serve semantics сохранялись; нельзя включать современный planner только потому, что unit tests зелёные.

[R1f review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-pluto-r-rebootstrap-review.json): cohort SHA `52d7a4a50c5f7048d39a4beea6d64c0c267e0c7d013088047267f0fa2b90aee3`. Typed READ410/409, pending snapshot UUID до RPC, невалидные PREPARING/AWAITING_FEED до current feed, bounded pages/bytes, exact binding/transport pins. Authority cache не сохраняет прежнее разрешение после failed refresh. Old signed CLI отказывается от staged state под held WAL. Full Go outcomes содержат explicit skips; это не «всё без skip».

Original R1e отказал на expired cursor до dispatch, R1f затем отказал на incomplete local scan/generation changed. Исходные 57 operations / пять sealed artifacts / четыре известных handles были сохранены. Каждый отказ имеет собственный result; быстрый отказ не является performance benefit.

### 10.2. R1g source remount принят отдельно

[Когорта](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/pluto-source-remount/cohort.json), SHA-256 `1a7c2bb71c47c7411e14d657d6853b33038a02034b7e729043b80486a373159d`, source revision `f0d05551b76a4487f609bfe914616666761dae45`.

[Root review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-pluto-r1g-review.json):1093 checks,164 sources/5 owned/159 protected, exact reverse. Two stable native observations при том же physical/config/file identity/link guard/boot позволяют явный mount-only successor через CAS и новую durable gap. Это не доказательство непрерывности контента: дальше требуется guarded hashing.

Mid-scan remount отменяет и joins workers, не запускает stale final sweep. RED original mount cascade и gap-after-directory-EOF сохранены и закрыты targeted tests. Full race236 top-level PASS, vet0. Из11 skips четыре permission случая дополнительно проверены actualUID65534; семь optional big остаются открытыми. Updater17, releaseGo12, Node16, bootstrap3; свои19 containers отсутствуют.

Accepted binaries:

- AMD64 SHA `e2538d96d653e69473320bdcb5e0f89a5f6a753a21fc412d2895e0c1e72eb2a5`;
- ARM64 SHA `3573f35f0572aba87ca1284a635595f04bc01de195f0175b0653c7726fa86a28`.

Linux repeat всё ещё может читать/hash содержимое. Нельзя приписывать ему Windows USN O(1) гарантии или объявлять zero-content no-change без измерения.

### 10.3. Последний actual original Recover на R1g

[Runner/root proof](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/pluto-r1g-root-review-df489bb7-a635-4467-befa-9e225506bc63/result.json):520 checks/50 closed inputs. [Raw результат](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/pluto-d1-recovery-r1g/recover-results/recover.stdout.json), [diagnosis](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/pluto-d1-recovery-r1g/RECOVER_FAILURE_DIAGNOSIS.md), [summary](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/pluto-d1-recovery-r1g/recover-diagnosis-summary.json).

Выполнена **одна** фактическая попытка 13 октября08:22UTC, 12.192 s, exit1:

- пять исходных file operations восстановлены; все57 исходных records теперь ACKed, immutable IDs и four known handles сохранены;
-1700 files наблюдались,1695 новых отказали **до capture/hash/source read**, новых uploads0;
-83HTTP requests,1 305 038 original sealed bytes;
- причина `remote cut has no qualified server authority`;
- exact owned container cooperatively joined/stopped08:22:20.813UTC; resourceStop=false, cleanup failures0;
- no retry, no final readback, no fresh cycle.

Current stopped DB SHA-256:

`e1824bd5f568a3f5b27c5648d4837164f51b7155af2e8db7bc89691345b4a242`.

Это уже не прежний после-R1f SHA8c125…: новые recipes обязаны учитывать реальное after-R1g state. [Хэши после остановки](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/pluto-d1-recovery-r1g/after-r1g-stopped-state-hashes.json).

Old3 B неизменны, добавлены5 **historical** B с sourceincarnation1/gap1/generation2; current sourceincarnation2/gap5/mount729. Эти пять всё ещё имеют localdirty/verification2, totaldirty2201/verif1700. Текущая equality не объявлена. Sealed live artifacts удалены только после original ACK; сохранённые before copies содержат исходные1 305 038 B.

## 11. Открытые реальные ошибки, которые нельзя скрыть новым профилем

### 11.1. Original Neptune 585 records /64 spools: local JournalGap

[Original initial result](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/neptune-d1-qualification-6d7aedb9-731d-4c7a-81e7-fb83c6a710d7/results/initial.json), [diagnosis](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/neptune-original-d1-resume-diagnosis.md).

Первый initial304 565 ms:500 dirs +21 files опубликованы,64 originals Uncertain/spools18 126 709 B,2200 indexed, B0. Всего585 work records; «21 published files» не означает21 baseline.

Same-original resume закончился до HTTP за1112 ms из-за invalid local cut/JournalGap. Поздний readonly OS query06:05:35UTC показал same journal `01dc6ff2f7335b65`, FirstUsn20 434 649 088/NextUsn20 475 302 312; retained cursor20 336 299 528 сейчас вне диапазона. Это доказывает **текущую** inadmissibility, а не точный FirstUsn в момент первого FAIL.

Решение: закончить и принять explicit JournalGap replacement; далее восстановить те же operations/spools и отдельно current qualification. Никакого reset/cursor-skip/generic Rebound.

### 11.2. Neptune ordinary D1 73267441: overlap folder/file publication

[Actual initial](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/nq-73267441-bearer/native-initial-0/result.json). Fixture `endurance-73267441-4535-454f-b244-1d7a83c6e807`; state `ENDURANCE/ns2-bearer/73267441`, scope `0e3ab841bd4841af9c937d0e38707032`.

Real initial186 581 ms /187 014 ms process, CPU31 546.875 ms, RSS111 042 560 B;421 dirs/7 files published,8 captures/1 010 454 B,2200pending/B0, firstpublication76 571 ms,451Gateway requests без transport errors. Retained429 originals:428Published-unacknowledged +1Uncertain/spool155 043 B.

Uncertain original file `batch-01/part-1/file-0001301.bin`:

- server operation `f9bdd48e-0ca5-4b34-b298-655849c1c791`;
- client operation `b0954bd7-1397-4801-8012-1151dd4fd29f`;
- key `neptune-cycle-b0954bd7-1397-4801-8012-1151dd4fd29f`.

Temp SHA/received bytes действительны, target отсутствовал, public claim не выполнен. В06:41:35.719UTC installed0058 verify line69 увидел конфликт: folder claim35.690 → published35.749. Это реальный local publication overlap, для него подготовлен fair admission successor из раздела6.5.

Отдельный самый ранний401 был ошибкой отсутствовавшего Bearer header стенда до original work и сохранён как другой профиль. Его нельзя смешивать с этим product FAIL.

После независимой приёмки fair admission выполнить runtime-only handoff с сохранением full binding/devices/spools/temp/IDs. **Сначала readonly native continuity:** из-за прошедшего времени USN cursor тоже мог выйти из диапазона. Если это произошло, сначала accepted Gap replacement; blind Resume не допустим.

### 11.3. Pluto original0057: четыре UNKNOWN предка

[Дизайн восстановления](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/pluto-original-0057-reconciliation-design-654c3064-a517-4dee-a130-f4edfcfa26cb/design.md), [test matrix](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/pluto-original-0057-reconciliation-design-654c3064-a517-4dee-a130-f4edfcfa26cb/test-matrix.md), [readonly inventory](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/pluto-original-0057-reconciliation-design-654c3064-a517-4dee-a130-f4edfcfa26cb/readonly-inventory.json).

Это **только дизайн**, cohort SHA `a2836141bcfded8e1d2fc521d1ecdae7eff0aa0e5f98f8697ffd768ca68a4f93`. Original server/SQL/clientconfig не менялись.

Root `01a132ce-600f-75b7-a874-d8afdd742983`, QUALIFYING, seq73, full seven-field binding/device/token неизменны, unresolved0. Четыре UNKNOWN: root→source→batch-00→part-0, aggregate1 305 038 B. У трёх descendants есть immutable CREATED receipts; bootstrap root не имеет scoped receipt, для него нужно accepted construction/custody proof.

Readonly physical tree:53 dirs/5files, текущие SHA совпали. Это подтверждает сегодняшние наблюдения, **не** само по себе историческую принадлежность backend.

Старый0050 renew_metadata trigger делал ancestor aggregate sizes UNKNOWN на seq55–58/60–63/65–68/70–73 после старого0054 upload commit.0058 исправляет будущие qualified aggregate-only updates, но **не лечит уже сохранённый UNKNOWN**. `activate_empty` требует seq0/empty и меняет binding; применять к populated root нельзя. Нельзя сделать QUALIFYING fixture ACTIVE одним ручным UPDATE.

Предложено следующее решение, ещё не реализованное:

1. Проверить текущую свободную SQL migration number;0059 — предложение, номер не зарезервирован.
2. Typed private offline operator: drain writers, coherent backup, custody и full-tree provenance; bounded≤500objects/depth128.
3. Short root-clock/descriptor CAS на seq73, четыре новых AVAILABLE upserts/meta UUID seq74–77.
4. Сохранить full binding/epoch/guard/QUALIFYING и старые receipts/history; immutable operator intent/result даёт lost-ACK replay.
5. Никаких физических/file-version effects, generic HTTP/DML или «repair по совпавшему stat».
6. Down отказывает после использованного repair; coherent export включает новую ledger shape.

Следующий исполнитель сначала независимо проверяет дизайн, затем clone RED→GREEN/migration/backup/down/protection. Только после этих gates — exact original offline handoff, сохранённый original Recover/readback/fresh. Прямой SQL repair исходного fixture сейчас не разрешён готовностью реализации.

## 12. Что действительно измерено по скорости и ресурсам

### 12.1. Baseline B0

[Qualified B0 build](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/baseline-d1-runners-qualified.json), [qualified result](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/baseline-d1-result-qualified.json).

Dataset D1:1700 files,500 dirs,17zero files,444MiB =465 567 744 B. Dataset SHA `7cfac12665adab6da9c4f7656977bfc30aad8849aa4dec0ddbed0bf7b357332c`, manifest SHA `92105dc6bf2fc5b13f8429a35dc49989471d8a648f4fa3344ee30dbe8f030cf6`.

Это frozen исходные tracked+dirty sources начала работ, **не удостоверенная точная production release**. Один sample на клиента, последовательные клиенты,8MiB/s/RTT0, полный authenticated backend readback3400SHA; сохранены735 product inputs/36payload assets. Нет variance/p95.

CPU/RSS в таблице относятся к клиентской процессной telemetry. Они не выражают суммарную стоимость всех server, Gateway и database процессов; для конечного сравнения нужно измерить и их.

| Клиент / режим | Wall time | CPU | Peak RSS | Работа с сетью |
|---|---:|---:|---:|---|
| Windows initial |331 318ms (~5m31s)|609.375ms|~98.4MB|1700PUT,501PROPFIND,4301MKCOL,1700HEAD +3metadata |
| Windows unchanged repeat |48 025ms|125ms|см. raw samples|501PROPFIND,901MKCOL,1700HEAD +3metadata, upload0 |
| Pluto initial |347 102ms (~5m47s)|7810.083ms|~12.98MB|1700PUT; полный request breakdown в result |
| Pluto unchanged repeat |106 801ms (~1m47s)|4825.902ms|~12.89MB|upload0, но выполнялась повторная работа |

Вся квалификация/readbacks/cleanup заняла918 039ms. Own cleanup PASS. Первоначальный DLL path ERROR206 сохранён как harness error, исправлен коротким audit path.

### 12.2. Какие выводы пока нельзя делать

**Matched N0 D1 ещё не завершён. Общий коэффициент ускорения не посчитан.** Новый D1 остановился, поэтому186.58s partial FAIL нельзя сравнивать с завершённым331.32s initial как ускорение. Исторический recovery12.192s не является новым full initial/repeat.

Structural500k checks показывают bounded DB/WAL/retirement, не весь native scanner/upload. Large-profile SQLite backup5.64GB→11.29GB reserve/48.575s и reopen1.6387ms — миграционная проверка, не скорость передачи файла.

Новый first publication76.571s и B0 first write15.881s получены на разных незавершённых композициях. Это повод исследовать phases и задержки подготовки, не доказательство победы или окончательной регрессии.

Спецификация `11.4 задаёт цели: p95 no-change≤2s при valid cursors для1700 и500k, constant network requests, first ready upload≤5s, edit→publish≤5s,500kRSS≤384MiB/рост100k→500k≤64MiB. **Ни один общий такой gate пока не доказан.**

Нужно сравнить finished B0/N0 на одном dataset/backend/policy/RTT с integrity, отдельно initial, repeat, K10, deep creation, restart/recovery. Измерять time-to-first-publication, wall/CPU/RSS/privatebytes, source reads/hash bytes, data/metadata requests, SQL calls/rows, catalog/journal amplification, queue depth, SQLite/WAL/temp/spool, bandwidth и disk free. Несколько samples нужны для distribution/p95; сравнение с пользовательскими30m/10m — контекст, не контролируемая baseline пара.

## 13. Инструменты будущего теста: что готово и чего ещё нет

[Конкретный контракт кампании S3](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/S3_CAMPAIGN_CONTRACT.md).

- Controller C3: [cohort](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/controller-c3-qualified-d092484e-7785-48c8-86e5-43b5a268053e/cohort.json).18 actual native **dummy** checks/66evidence. Policy10GiB/8GiB/aggregate labeled CPU4.5; missing/duplicate/stale policy/pins и неизвестная telemetry fail before launch. Seven unique runtime pins; final admitted dummy round завершён после cut, новых rounds нет. Protected watchdog/window/native helpers byte-identical previousS2. Это LIMITED infrastructure, не actual6h product composition.
- Gateway [endurance-gateway.mjs](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/endurance-gateway.mjs): aggregate input+output8MiB/s,64KiB blocks,16streams, fixed loopback/TTL и finite faults;7 tool tests.
- [verify-dav-dataset.mjs](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/verify-dav-dataset.mjs): authenticated SHA/count/prefix, no redirects, bounded streaming;6 tool tests.
- Ordinary main lifecycle/native helpers: Windows Job, FILETIME/full command/executable identity, cooperative join и exact own cleanup приняты отдельно. Hard watchdog имеет финальный bounded drain, не бессрочное ожидание.
- Windows audit stress payload с disk10 принимался **только против stage2 Core**,12win-x64 assets,7nativeguard tests/126root/80PDB. Product default40GiB не менялся. Его нельзя считать final stage3/Gap payload.
- `ordinary-native-*`, `qualify-windows-native-round` и соответствующие setup/inspect относятся к конкретному сохранённому FAIL/подготовке. Это не готовый универсальный accepted mixed driver.

**Нет** готовой принятой final mixed round композиции Neptune+Pluto+ordinarySaturn, no-change/K10 общей qualification, final payload и начатой6h кампании. Примеры CLI `inspect/migrate` в оригинальной спецификации описывают желаемый интерфейс; наличие текста не означает, что такие команды уже реализованы.

## 14. Рабочая среда и сохранённые ресурсы

### 14.1. Git и важные локальные данные

Снимок13 октября09:26:30UTC перед финальным редактированием документа:

| Репозиторий | HEAD | Porcelain entries |
|---|---|---:|
| Saturn |293a2d613fe3f97fcca401bb74381fe4997ec27b|165 |
| Neptune |9eebcfebdc77e7b05605194092928457b8d81579|148 |
| Pluto |28b114b26754f43fd2cdd95d71e5cd5fdfa1c1a2|134 |
| Kernel |5b98b409a3223d4d52452fc6c16efe35b9ad2fed|0 |
| Updater |17e2dcf1e72bbc6492ea5692520932d1c95a618f|0 |
| Mastermind |668b733b1a2921c81f0a07d0ba3d5a065f38e1d3|0 |
| Gryphon |0d60a9f21ab3ff21058e7b9055386a10d0002130|0 |

Количество entries не равно числу наших правок; dirty включает пользовательские изменения и untracked. Все источники нужно заново сопоставить с source-inventory/before/owned/protected. **Не делать git reset/clean, массовый checkout или пересборку снимка из current без diff.** В живых проектах в рамках этих работ релизные commits/push/deploy не выполнялись. Audit Git revisions относятся к изолированным snapshots.

Original client profiles/SQLite/WAL/spools, server private configs, source snapshots и volumes сохраняются. SQLite migration backup должен быть согласован с WAL; копирование одного открытого .db не доказывает сохранность. Secrets не помещать в MD, публичные logs, screenshots, commit или share.

### 14.2. Пассивные ресурсы при остановке

Это **инвентарь на момент передачи**, а не разрешение воздействовать на PID по номеру. После переезда в другой чат заново проверить Win32_Process.CreationDate/FILETIME/full command/exe hash и Docker fullID/Created/label/image/mounts против owned manifests.

| Ресурс | Идентичность при передаче | Состояние / назначение |
|---|---|---|
| Original0057 fixture Node |PID21768, FILETIME134363316638150940, Created02:21:03.815094UTC13Oct |Пассивный loopback57344 QUALIFYING server; BelowNormal/affinity15; recipe содержит pinned identity |
| Original PostgreSQL |c1f7c602d398b857431f8f46a0572a27ff98ad013cceed58b26a6f7ca24276ae; Created01:09:03.308981738UTC |Running idle,1CPU/512MiB; label exocortex.sync-performance.run=61e7d3da-2405-4b3e-9547-bdc406f27436 |
| Ordinary732 PostgreSQL |0021e67deac6b6982ed9dcb14dcabe462765fc7de2752692c9b2487cf2d60a5d; Created06:23:23.556605346UTC |Running idle,1CPU/512MiB; own73267441 fixture |
| Ordinary732 SFTP |fe4d3335f5d01ff2393dfb88edfe3b66c43d0f853d4bed42b6033bdd1fc1950c; Created06:23:26.464507243UTC |Running idle,1CPU/256MiB; same own fixture |
| Original Pluto container |993d9108c8923d642855bd4901f8ef214c212644ae4d046d41507f79d4b61b45; Created01:19:15.549024454UTC |STOPPED; exact private volume retained; latest after-R1g DB important |
| Foreign Volt |volt-development-volt-1 и любые не-owned ресурсы |Не трогать |

Original Node command использует `scripts/serve-private-read-resume.mts` и private config в `modern-client-fixture-handoff-0057-05df049d-b931-45f3-b339-02a0413ad62e/server-cohort/server.private.json`. Это не ordinary ACTIVE main. Полная команда фиксируется в machine snapshot, без вывода credentials.

Original Pluto label `exocortex.sync-performance.run=a45b7014-a39a-4c4d-aebc-5227700c09e2`; volume `pluto-d1-a45b7014a39a4c4daebc5227700c09e2-private`. Не удалять для получения нового чистого initial.

Перед остановкой aggregate test Docker quota3CPU; свободный disk~40GiB/memory~29.46GiB. Эти числа меняются, измерять заново. Новые тестовые ресурсы не должны вместе с оставшимися превысить4.5CPU. Остановка пассивного server также меняет pinned recipes: только доказанное ownership, запись lifecycle и явный successor inventory.

### 14.3. Автоматизации и состояние чата

Старая heartbeat `saturn-neptune-pluto` **уже PAUSED**:

- файл `C:/Users/pc/.codex/automations/saturn-neptune-pluto/automation.toml`;
- kind heartbeat, interval30min;
- target old thread `01a0fdd8-fad3-7f62-b0f8-3bd1e076d7c7`;
- её prompt относится к старому12h тесту, не к новой6h кампании.

Новый6h manager/watchdog/run window не создан. Не возобновлять старую12h automation для новой цели. Когда новая кампания будет действительно готова и запущена, изменить существующую подходящую automation через app tool с сохранением полей/notification intent и привязкой к реальному new run/chat либо создать корректную heartbeat без дубля. Сейчас ничего автоматически не запускается.

## 15. Что делать следующему программисту — последовательность с результатом каждого шага

### Шаг 1. Восстановить контекст и безопасную исходную точку

Прочитать этот документ, original spec, матрицу и последние ownership/cohort files. Заново собрать readonly Git/disk/memory/process/container inventory; подтвердить preserved original DB/seals/server identities. Сохранить свой before snapshot, отличить пользовательские dirty от owned delta.

**Готовность:** known current inventories и exact paths, secrets private, нет незапланированного active workload. Если identity изменилась, не управлять процессом/ресурсом по старому PID/имени; новый handoff документировать отдельно.

### Шаг 2. Независимо принять Saturn fair admission

Проверить7owned/496protected, exact reverse,304source/474emitted runtime freeze, actual PG/local/SFTP/normal-main evidence и сохранённый RED. Убедиться, что release slot до terminal не ослабляет SQL UNKNOWN/foreign fences, очереди/abort finite, limits не меняют существующий protocol.

**Готовность:** отдельный root-review PASS с hashes и обновлённая строка матрицы. Только после этого готовить runtime successor оригинального ordinary732 fixture; не выполнять blind retry.

### Шаг 3. Завершить JournalGap replacement

Продолжить раздел8, не переписывая accepted stage3. Сначала old4 held-WAL/newPID/interruptedactivation/ownership/quotas, затем full Core/WPF/PDB/protection/real Saturn gate. Root принимает отдельную новую когорту.

**Готовность:** сохраняются старые gap/cursors/B/585records/64seals на negative cases; explicit replacement имеет durable original UUID/link, новый qualified L/R, historical и current agreement не смешаны, g+1 остаётся dirty.

### Шаг 4. Подключить accepted IdentityOnly к обычному Windows bridge

Выполнить narrow scope раздел9. Проверить missing source до anchor HTTP, native proof без elevation, modern capability no-fallback, preserved enrollment/DPAPI/pause/mapping. Затем общий final Core + bridge с real ordinary Saturn initial/restart/fresh/K10/HTTP и normal HTTPS gate.

**Готовность:** реальный service path использует принятый новый engine, нет второй пользовательской WPF instance и изменения paused production profile. Build-only не закрывает interop.

### Шаг 5. Реализовать безопасный server repair для original Pluto fixture

Root-review дизайн раздел11.3. Проверить фактическую свободную migration number. Реализовать typed offline repair на clone с coherent dump/restore, exact custody/physical provenance, clock/CAS, immutable operatorreceipt, lostACK, backup/export и down refusal. Нет generic «UNKNOWN→AVAILABLE».

**Готовность:** clone RED→GREEN и separate accepted cohort; только затем original drained handoff с тем же full binding/root/history. Не активировать populated QUALIFYING root через empty-root API.

### Шаг 6. Довести original recoveries до результата

Восстановить original Neptune585/64, ordinary732429/1 и Pluto after-R1g57ACKed/currentauthority. Перед эффектами сверить latest readonly current identities и nativejournal; исходные UUID/key/spool bytes сохраняются. В Pluto recovered historical lane уже выполнен — не повторять его как новую initial с новыми keys.

**Готовность:** оригинальные uncertain operations имеют доказанные terminal outcomes; qualified current agreement построен отдельно; authenticated readback, fresh no-change, K10 и newdeepfile проверены. FAIL и доказательства до ремонта остаются в истории.

### Шаг 7. Закрыть обязательные remaining spec gates

Для initial/repeat priorities: metadata amplification, byte budgets, parent/dependency uniqueness, enumeration/highscale, nochangeK10, resource bounds, safe server conflicts/g+1, restart/lostACK/root substitution, populated upgrades. Далее namespace/moves/deletes/excludes и small-file batches/adaptive fairness. Optional blockdelta/dedupe/Merkle включать только с capability/integrity/economic proof и документированным fallback.

**Готовность:** строки матрицы имеют exact product cohort/raw evidence, не общие обещания. Если часть optional ускорений не применяется, явно объяснить reason/capability; не скрывать обязательные несовместимости за N/A.

### Шаг 8. Собрать final общий Windows payload и проверить миграционный порядок

Один final WPF publish → MSI+ZIP, exact Core/payload manifests, update/profile/installed guards и notices. Old accepted stage2 audit driver не подменяет finalCore. Закрыть доступные Core/Linux/Go/PG/common regressions, retained migrations/oldreaderrefusal. Native installer/UX отсутствие среды оставить UNVERIFIED.

**Готовность:** final tested code == shipped payload inputs, profiles/pause/credentials/originaloperations сохраняются. Недоступные native gates — явное ограничение release, не зелёный PASS.

### Шаг 9. Измерить matched N0 и квалифицировать real mixed driver

На том жеD1/backend/policy сначала finished N0 initial/repeat, затемK10/newdeep/mutations/recovery с backendSHA. Несколько samples; сравнить сB0 по времени/CPU/RSS/bytes/requests/DB/WAL. Подтвердить real normal API/worker+Windowsengine+Pluto+aggregateGateway/Job и final round drain на short bounded qualification.

**Готовность:** исправленные actual clients, измеренный успешныйN0, final mixed resources/ownership/status/metrics/join. Только после этого перейти к правилам6h последнего раздела.

### Шаг 10. Финальная приёмка и передача результата

После6h оформить по-cohort итог stability + efficiency, accepted/open/skipped/nativeUNVERIFIED и ссылки на raw evidence. Остановить только owned нагрузку и приостановить heartbeat. Production release/deploy или возобновление большого пользовательского sync не входят в автоматическое завершение локальной кампании.

## 16. Организация разработки, тестирования и документации

Пользователь просил привычный порядок: конкретные задачи поручаются агентам, основной агент координирует интеграцию и приёмку. В новом чате продолжить так после возобновления задачи:

| Роль | Отдельная область работы | Что передать интегратору |
|---|---|---|
| Агент Neptune | Завершение JournalGap replacement в узком Core/test scope | Diff, исходный снимок, hashes защищённых файлов, raw RED/GREEN, миграция, новый PID, binaries/PDB |
| Агент Saturn | Независимая проверка fair admission либо offline repair отдельного fixture | PG/local/SFTP и normal API/worker evidence; SQL, authority и provenance invariants; cleanup своих ресурсов |
| Агент Windows/Pluto | Отдельная интеграция Windows bridge либо current Pluto recovery | Принятый predecessor, runtime interop, исходные операции/состояние, tests и diff |
| Оркестратор | Общие контракты, ресурсные окна, независимая приёмка, документация, benchmark и кампания | Согласованные межпроектные identities и итоговые gates |

Не давать двум агентам одновременно изменять формат базы, общий contract, номер SQL migration или Windows payload. Зависимые реальные тесты сериализовать по CPU, диску и ownership. Три агента не означают три одновременно запущенных больших нагрузки. Принятый снимок нельзя молча обновлять вслед за live edits.

После **каждого** изменения обновлять этот документ и матрицу. Записывать дату UTC/local, причину, owned files, predecessor/successor hashes, raw FAIL и результаты повторной проверки, сохранность чужих правок, cleanup, ограничения и следующий шаг. Не переписывать старый отказ как ретроспективный PASS.

Минимальный порядок приёмки инкремента:

1. Воспроизвести точную причину первичными данными, отделив ошибку продукта от ошибки стенда.
2. Сделать узкую правку с записанной областью владения и сохранением пользовательских dirty files.
3. Выполнить релевантную регрессию, проверки целостности и обновления сохранённого состояния.
4. Для runtime changes проверить взаимодействие реальных компонентов. Fixture не заменяет ordinary main или native service.
5. Сопоставить исходники, binaries и PDB; проверить защищённые файлы, обратный patch и согласованную резервную копию.
6. Независимо принять когорту, затем ограниченно повторить исходный сценарий с теми же IDs и bytes.
7. Провести общий smoke после интеграции; расширять набор тестов, если изменения, ошибки или неопределённость это оправдывают.

Нельзя снижать проверки bytes/hash/provenance ради красивого времени. Нельзя «лечить» end-to-end отказ чистым профилем, повторным bootstrap, поддельной authority, synthetic receipt или безусловным ack/B.

## 17. Правила запуска шестичасового стресс-прогона

Это инструкция **на будущее после завершения реализации и обязательных проверок**. Пользователь разрешил шестичасовой локальный тест, автоматический контроль каждые 30 минут, локальные исправления и повтор провалившихся сценариев. Последняя просьба остановить работу означает: **в этом чате тест не запускается.**

### 17.1. Условия до START

- Закрыть шаги 2–9 раздела 15 и обязательные строки [матрицы принятия](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_ACCEPTANCE_MATRIX.md). Открытый original failure нельзя скрыть новым пустым dataset/profile.
- Зафиксировать final Saturn/Neptune/Pluto sources, binaries, dependencies, migrations, resource policy, driver, Gateway и native helpers. Сохранить hashes, protected inventory и diff. Windows payload должен содержать тот же Core, который квалифицируется в кампании.
- Провести короткий реальный mixed gate: normal API/worker + настоящий Windows Core + Pluto; authenticated backend hashes, restart/recovery/migration и cleanup процессов/контейнеров.
- Сохранить согласованные before backups и dataset manifest. Использовать отдельные private profiles, roots, devices, tokens и ports; постоянное состояние Windows и Pluto раздельное. Не брать пользовательские 154 GB каталогов.
- Учесть **все** сохранённые и новые тестовые контейнеры в resource admission. Неизвестная или устаревшая telemetry — отказ до новой нагрузки.
- Отдельная Windows-среда для installed/WPF отсутствует. WSL/Linux runner не доказывает работу WPF; native Core проверяется на Windows в собственном audit профиле. MSI install/update/autostart/UX остаются явным ограничением.
- Создать один новый каталог кампании, runId и manifests состояния/ресурсов/источников/данных/метрик. Не использовать старый 12h run directory и его startedAt/deadlineAt.

Черновые drivers пока не дают готовую команду «запустить всё на 6 часов». Выбрать фактический проверенный entrypoint из final cohort и сохранить полную команду в run manifest. Примеры CLI из оригинальной спецификации не считать уже реализованными командами.

### 17.2. Один срок admission и конечное завершение

При START сохранить неизменяемые `startedAt`, `admissionDeadlineAt = startedAt + 6h` и `finalDrainDeadlineAt`; запустить независимый deadline watchdog. Admission — разрешение начать очередной round. Анализ, исправления, rebuild, простои и retries входят в те же шесть часов.

После admissionDeadlineAt **не запускать новые rounds или retries**. Последний round, допущенный до границы, довести до terminal result. Его конечный timeout должен быть квалифицирован и записан до START. Подготовленный controller допускает ограниченный drain максимум 45 минут; конкретную границу нельзя расширять после старта. Watchdog завершает только принадлежащие кампании остатки к hard final deadline.

Если менеджер умер, сначала сохранить diagnosis и очистить только доказанно принадлежащие прогону ресурсы. Resume допустим в исходных границах с тем же runId, состоянием и pending originals. Он не сдвигает startedAt/deadlines и не создаёт новое окно, чтобы компенсировать простой.

### 17.3. Лимиты и защита пользовательской среды

| Ресурс | Обязательное правило |
|---|---|
| Свободный диск | Не ниже **10 GiB**: пользователь разрешил этот тестовый порог. Product default 40 GiB и прежние frozen results сохраняются |
| Свободная RAM | Не ниже **8 GiB** |
| Docker CPU | Все тестовые контейнеры вместе не более **4.5 CPU**, включая оставшиеся fixtures |
| Native / Node | BelowNormal, affinity 15; DOTNET_PROCESSOR_COUNT=2. Проверять фактических descendants, не только launcher |
| Gateway | Совокупно входящие и исходящие bytes не более **8 MiB/s**, с ограниченными streams/buffers; не по 8 MiB/s каждому клиенту |
| Corpus / temp / history | Ограничить bytes, files, versions, spool, WAL и backups. Резервировать диск до capture/backup; cleanup имеет конечный срок |
| Реальная синхронизация | Downloads client, профиль, pause и пользовательское дерево не менять. Не запускать второй пользовательский клиент и не возобновлять mapping |
| Production / foreign resources | Не использовать real Kernel/Saturn, не публиковать release/deploy, не касаться чужого Volt и чужих volumes/containers |

При нарушении порога или помехах работе ПК прекратить новые тестовые admissions и снизить/остановить **только** подтверждённую собственную нагрузку. Сохранить текущие operations/artifacts, записать причину и простой. Реальную sync policy не менять.

### 17.4. Разнообразные сценарии

Проверять по отдельности и совместно Windows + Pluto через обычный локальный Saturn и квалифицированный SFTP backend:

- Первоначальный D1: ранняя загрузка после готовности parent, глубокие и широкие деревья, новые поддеревья, мелкие, нулевые и крупные файлы в пределах продуктовых лимитов.
- Повтор без изменений при valid cuts; K10; один новый глубокий файл; burst/debounce; изменение файла во время публикации поколения g; server-version conflict.
- Новый PID с тем же профилем; потерянный prepare/complete/status ACK с original keys/bytes; конечные 429, backpressure, timeouts и disconnect.
- Рестарт worker/API/Gateway/клиента и восстановление: нет потерянных задач, повторной публикации либо лишних версий.
- Typed remote cursor expiry/journal gap/rebootstrap и explicit local JournalGap. Dirty/current B не подменять историческим receipt.
- Root rename/substitution, mount re-observation и permission failures в реально поддержанном coverage. Опасные неподдержанные paths должны давать точный отказ и сохранять состояние.
- Upgrade/migration, old-reader refusal и held WAL; interruption на cut/activation; coherent backup/restore только квалифицированным способом.
- Fairness мелких и больших jobs; ограниченные CPU/RSS/DB/WAL/spool/temp/queues/requests/bytes.
- Authenticated readback с SHA/count/history/namespace/peer isolation после существенных faults.

Unsupported move/delete/takeover нельзя объявлять PASS успешным fixture. Если ожидается безопасный отказ, проверять typed reason и сохранность; это отдельное покрытие, а не приёмка положительного сценария.

### 17.5. Автоматический контроль каждые 30 минут

После фактического START настроить **heartbeat нового чата** через app automation tool. Сохранить существующие поля и notification intent, не создавать дубли. Prompt должен содержать exact new run path/runId/deadlines/ownership policy и запрещать новое окно.

Старая 12h automation сейчас PAUSED. Её нельзя случайно возобновить с прежним prompt; сначала обновить к реальному новому прогону и чату. Не подменять thread heartbeat самостоятельным cron job.

На каждом wake:

1. Читать status, последние mixed-load-results/metrics, новые FAIL, upload-terminal diagnostics и tails manager/round/API/worker/Neptune/Pluto.
2. Сопоставлять с собственным `monitor-state.json`: сохранять уже обработанные ошибки, когорты, diagnosis и notifications, исключая повторные уведомления.
3. Проверять фактические manager/current PID/owned processes/independent watchdog по native creation и полной команде, обновление logs/metrics, disk/RAM/aggregate CPU и сроки.
4. Ожидаемый transport fault не считать самостоятельным product FAIL. Оценивать последующую целостность, исходные операции, backlog и восстановление.
5. Молчать без существенных изменений. Уведомлять о новом подтверждённом FAIL, зависании/остановке, исправлении и его регрессии, новой когорте, нужном действии пользователя либо завершении.

### 17.6. Исправления и retry внутри того же окна

Сначала сохранить конкретную failed check, diagnosis и первичные доказательства. Минимальную правку внести в соответствующий live project и отдельный frozen successor, сохранив чужие dirty files. Записать diff/protection/migration, выполнить релевантную регрессию. Даже однофайловое исправление получает отдельную cohort ID; результаты старого и нового кода не смешиваются.

Retry продолжает **тот же исходный сценарий** с original operation UUID, idempotency key, sealed bytes и persistent state. Control protocol брать из фактической принятой версии менеджера; записывать новый request UUID, failed check, diagnosis, evidence и rebuild flag. Если менялся агентский binary, его snapshot пересобирается до retry.

После трёх одинаковых падений без новой причины или исправления остановить собственную нагрузку и сообщить препятствие. Не делать четвёртый слепой повтор. После admission cut новые fix retries запрещены; завершается только ранее допущенный round. После hard final deadline нагрузочных процессов оставаться не должно.

### 17.7. Итог, эффективность и остановка автоматизации

Итоговый отчёт содержит:

- Неизменное окно, фактическую длительность нагрузки, простоя и final drain; число рестартов и ремонтов.
- Успешные, failed, unresolved и skipped сценарии отдельно по когортам, с доказательствами и initial/repeat/K10 timing.
- Operations/dirs/files; data/source/hash/metadata bytes; requests/SQL calls; CPU/RSS/private memory/WAL/spool/temp/queues/disk.
- Authenticated integrity, current baseline, history, отсутствие потерянных задач и восстановление после сбоев.
- Сопоставимые B0/N0 deltas и ratios для **завершённых одинаковых сценариев**. P95/variance выводить только из достаточного числа samples. Partial FAIL и dummy не выдавать за ускорение.
- Ограничения: недоступные MSI/autostart/WPF; Windows engine на Linux, если именно так он проверялся; fixture Kernel и экспортёры кроме Saturn; ограниченный backend/writer coverage и ресурсные лимиты ради ПК/реальной синхронизации.
- Cleanup exact owned processes/containers, сохранённые диагностические данные и readonly final inventory.

Затем **приостановить heartbeat через automation_update, сохранив её поля**, записать это в отчёт и обновить матрицу. Завершение 6h кампании не разрешает автоматически production deploy/release либо возобновление paused пользовательского mapping.

## Повторная проверка 2026-10-13 — 2026-10-13 12:57:23 Europe/Istanbul / 2026-10-13 09:57:23 UTC

По новому указанию оператора работа возобновлена: повторная проверка выполненного, завершение реализации и тесты. **Шестичасовой прогон запрещён до отдельного явного указания.** Журнал: [события и входные/выходные гейты](C:/.projects/exocortex/.history/2026-10-13-sync-implementation-revalidation.md). Новый audit: C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229.

Перед изменением product sources сохранены 986 before files; Git identities и dirty counts совпали с handoff. Fair-admission: 2557 hash checks без расхождений; повторная текущая unit-регрессия 42 files / 306 PASS / 0 FAIL / 0 skipped. Это ещё не финальная приёмка: actual PG/SFTP/normal-runtime revalidation и reverse/runtime closure OPEN. Прежние FAIL и границы покрытия сохраняются.

### 2026-10-13 13:06:41 Europe/Istanbul / 2026-10-13 10:06:41 UTC — повторные runtime gates и найденный gap defect

Saturn current units306/306 и actual PG/local + strict SFTP/normal API/worker повторены успешно на новых private fixtures; собственные2containers/2volumes удалены. Runtime sources304/emitted474 совпали. Raw reverse mismatch из-за CRLF patch сохранён отдельно от повторной LF-проверки. Neptune:3 новых seed/activation regression tests воспроизвели FAIL; узкое исправление4файлов проходит targeted qualification, финальный PASS ещё не заявлен. Подробные причины/входные и выходные гейты: [.history journal](C:/.projects/exocortex/.history/2026-10-13-sync-implementation-revalidation.md). Original states и запрет6h сохраняются.

### 2026-10-13 13:13:10 Europe/Istanbul / 2026-10-13 10:13:10 UTC — JournalGap targeted16/16

Новый seed-boundary successor прошёл16/16targeted безskip после сохранённого промежуточного14PASS/2FAIL и исправления incomplete-candidate cleanup. FullCore и newPID/old4-held-WAL ещё выполняются/готовятся; finalJournalGap не принят. Saturn runtime/reverse785/785PASS, включая exact before hashes после нормализации только patch. Полный журнал: [.history](C:/.projects/exocortex/.history/2026-10-13-sync-implementation-revalidation.md).

### 2026-10-13 13:24:16 Europe/Istanbul / 2026-10-13 10:24:16 UTC — повторная проверка выявила дополнительные дефекты

newPID JournalGap и actual old4-held-WAL прошли на gap-only successor (подробности/пределы в [.history](C:/.projects/exocortex/.history/2026-10-13-sync-implementation-revalidation.md)). FullCore959:950PASS/9FAIL/0skip; все ошибки сохранены. Выполняется narrow WalAdmission fix с2RED, корректировка synthetic500k prefix fixture и повторUI из правильного output path. FinalCore/cohort/interop остаются OPEN, прежний PASS не переносится на изменённый binary. Запрет6h сохраняется.

### 2026-10-13 13:27:23 Europe/Istanbul / 2026-10-13 10:27:23 UTC — Wal/continuity/UI60PASS

wal-green60/60PASS/0skip, включая same-subscription resume после held-WAL release и отказ при actual expired journal bounds. Уточнён test-only expected spool-floor refusal; whole-profile contention дополнен отдельным spool. core-full-2 выполняется на final current Core. Все прежние FAIL сохранены; окончательная приёмка остаётся OPEN.

### 2026-10-13 13:48:53 +03:00 — повторная проверка и Windows bridge draft

Core full962/962 PASS,0skip;94PDB inputs verified; final Core newPID/old4-held-WAL PASS на отдельном native fixture/FakeRemote. WindowsGuardedMappingSession теперь явно выбирает IdentityOnly+parent reconciliation после native/readonly continuity admission; generation сохраняется, pending/NeedsAttention replacement блокируется. WindowsGuarded/enrollment/preferences60PASS; WPF build0warning/0error. Real ordinary HTTP/HTTPS, original recovery, source closure bridge и final bundle ещё OPEN. Pluto race236PASS/11skip +vet PASS; permission/release repeats OPEN. Saturn fair review PASS_LIMITED_PROCESS_LOCAL_REVALIDATION. Полные события/исходные FAIL: .history/2026-10-13-sync-implementation-revalidation.md; evidence: .audit/2026-10-13/sync-revalidation-095229. **6h запрещён без отдельного явного указания оператора.**

### 2026-10-13 14:20:13 +03:00 — actual ordinary mapping/Gap composition PASS

Frozen complete capsule215 inputs/13owned/202protected; actual PDB94Core+6Windows bridge PASS. BareUUID mapping-anchor compatibility исправлена без смены оригинального ключа; transport+bridge67PASS. Actual ordinary API/worker+SFTP:6distinct native PIDs, initial10files, restart0capture, K10 exactly10publications, explicit injected JournalGap replacement retains historical originals, current equality10/no new upload, post-gap restart0capture,60DAV SHA PASS; cooperative cleanup exact own resources PASS. Raw full3:982/983PASS +one native scheduling FAIL; corrected serial native17PASS, full4 RUNNING. WPF build0warn0error. HTTP mapping-session proof does not close normal WindowsSyncService/HTTPS, original D1 recovery, final release or6h. Evidence .audit/2026-10-13/sync-revalidation-095229; full event log .history/2026-10-13-sync-implementation-revalidation.md.

### 2026-10-13 16:05:02 +03:00 — итог Neptune cohort и offline repair clone

Neptune cohort8939d99d-3a08-4b85-b0c5-45b7fa5dd949:983/983PASS0skip;215inputs/13owned/202protected;308PDB docs; newPID/old4-heldWAL и actual ordinary HTTP подтверждены в ограниченном scope. Прежний статус full4 RUNNING закрыт. Saturn legacy5,unit306,operator63PASS/1прежнийoptionalskip;full lint/API/scripts types exit0. Typed0059/Windows custody/privateCLI реализованы и проверены только на clone; actual HTTP historical/current metadata gate выполняется. Original repair/recoveries, fullWindowsService/HTTPS, finalrelease иN0 ещё OPEN. Подробности и raw FAIL в .history/2026-10-13-sync-implementation-revalidation.md.6h запрещён без нового явного указания.


### 2026-10-13 16:19:23 +03:00 — original Pluto server repair accepted

Offline clone cohort995ad5a0-6be8-4994-9adc-c6b1f82a0362:16owned/615protected, exact reverse,63PASS/1existing optionalskip, SQL41groups/CLI6groups/HTTP PASS. Original coherent backup+restore PASS;0058/0059 applied once, typed operation5b505e85-6163-43bd-8f40-6c9d7cee9817 repairs4UNKNOWN seq73→77,57historical operations exact. Private permit closed. Original successor now PID29800/native134363710387523620 atsameport57344, samefullbinding/QUALIFYING; sourcefe5f4f2394cf2c9953412a3263ccd062cb4cba0782e5f4973bc16746f3ab3f6f. OLD PID21768joined; do not use old PID recipes. Actual fresh58AVAILABLE/5fileSHA PASS. Pluto client1700/currentagreement/repeat stillOPEN, no6h. Raw schema-comparison and old-pin startup refusals retained. Full lifecycle/private references in .audit/2026-10-13/sync-revalidation-095229/folder-revalidation/private/original-successor; public journal .history/2026-10-13-sync-implementation-revalidation.md.


### 2026-10-13 17:47:00 +03:00 — текущая повторная квалификация и оригинальные состояния

Saturn0059 original repair и subsequent same-token full-chunk recovery завершены с coherent backup/actual restore12table-ledgers и native held-temp proof. Frozen fair server сейчас PID29748/native134363760127153918/port57344/sourcee1f7bc0a702b72f901f26be234063b54ccdd151fa8cb148f1e0a5334c57fa9d2; прежние PID29800/33768joined. Pluto spool cohort07a96cf8…:race239PASS/11previousskips,release16Node+12Go+permissions6groupsPASS; actualoriginal1700Complete/zeroPending/all2201immutableACK. Raw wrapperFAIL retained (audit relative-backup assertion), corrected16checks on stopped copy PASS; readback/freshOPEN. Neptune v1 cohort1858eaae… fixes recognizedNamed-v1 explicit replacement:215sources/13owned202protected/PDB94/Coref85ff2e…;101targetedPASS,full986=979PASS7path-layoutFAIL, samebinaryUI7PASS. OriginalNeptune585 sameexplicitrequest prepared, recoveryOPEN. Earlierbridge983/cohort remains historical and does not qualify newCoreWPF/HTTPS/release. Journal contains complete failures/gates. **6h запрещён без нового явного указания.**

### 2026-10-13 18:36:11 +03:00 — original recoveries и anchor successor в проверке

Pluto original принят по recovery/readback/fresh:2201ACK/0pending,1700authenticatedSHA/465567744B; fresh63.672s всё ещё читает465567744B, поэтому PERF-06 performance остаётся OPEN. Windows original585 immutable/521oldresults сохранены,585phase5. Additive0060 limited1024node private repair принят cohortb12d4d49-d8da-470d-b8cc-4be661b31f6e:31unit/native+9PGinternal+306common; coherentbackup/restore12ledgers PASS. Original typedCLI16metadata repairs→seq847,586AVAILABLE/85authenticatedSHA; все585serveroriginals неизменны.

Retained Neptune после repair выявил новый anchor_json=NULL / cursor-expiry defect. Узкое исправление переносит прежнюю проверенную ancestry только внутри исходного explicit request и сохраняет отказ на изменённые raw names. RED2FAIL/2PASS→selected98PASS; frozen215/13owned202protected/exactreverse13/PDB94PASS; Corea51af52e78b1bf18c143fa659c278b1615a7fc966f603c356ee2677f9e866f2c, полный набор ещё RUNNING, original retry ждёт qualification. Подробные входные/выходные gates и raw paths — в журнале текущей работы. Final payload, ordinary732 recovery, matched performance и остальные обязательные этапы OPEN; six-hour campaign запрещён и не запускался.

### 2026-10-13 19:16:31 +03:00 — parent membership recovery в проверке

Anchor successor a4936a62-0160-44bf-807e-ad280b676f40 принят:990/990PASS,Corea51af52e… . Actual original585 retry54.895s сохранил585immutable/521oldresults, но остановился на16неизвестных hardlink events и104065последующих неопределённых events. Anchor наследование выполнено корректно; текущая membership closure потребовала отдельного расширения, эти события не объявлялись Outside.

Новый draft parentmodulev2 сохраняетv1WALbackup иoriginalplan/USN; boundedполный dual-nativecurrenttree proof разрешает продолжение только при отсутствииunknownhardlinkID внутри дерева и неизменномcut. Known-inside/duringcut/rootchanges отказывают, postcut uncertainty не очищается старойproof. RED2FAIL→early42PASS→expanded48PASS; combined153 дал1реальныйcutfailure, исправлен,7criticalcasesPASS. OldCorea51… refusedv2 без DB/WALmutation. Frozen216/21owned195protected/exactreverse21/PDB95/Core095e5d5f…;full1000RUNNING, original новыйdraft ещё не запускал. Ordinary429backup/restore12tableledgers+8SFTPfilesPASS, fairruntime778pins;runtimehandoff ещёOPEN.6hне запускался.

### 2026-10-13T16:31Z — membership acceptance и ordinary runtime successor

Membership cohorta8195cc7-1d83-42ea-92df-748d8c952f25/Core095e5d5f…: full1000/1000PASS0skip,critical7PASS,oldCorea51refusesv2withoutDB/WALmutation.216sources/21owned195protected/reverse21/PDB95/41driverpayload pins exact. Same-request original585recover RUNNING(PID26360/native134363823708535516), not yet current-qualified. Originalordinary732 config/backups/restore/fair778pins verified; actual API25016/worker5980/gateway26768 started under ownrun d7aa1db4… with3ready200/8MiB/s/45mdeadline, preserved origin59996. Client429 not yet restarted; allfinalperformance/remainingstagegates remain OPEN. Private identities in .audit/2026-10-13/sync-revalidation-095229/ordinary-original-runtime/private; complete evidence in .history. Six-hour campaign not started and still requires explicit operator instruction.

### 2026-10-13T16:56Z — original resource regression

Membership Core095e… full1000PASS остаётся acceptedlimited. Actual585 recovery1347.780s FAIL InboxCapacity before any new file publication; local501parent/2200entry currentmembership installed and replacementRemoteQualified reached, then rawinbox1763654records/268419272B reached256MiB. Old585immutable/521results/current585results exact; stopped688803840BDB copy and original SQL plan saved under neptune-original-replacement-membership/after-inbox-refusal. Current replacement subscription now invalid with typedInboxCapacity(gap_epoch1); no cursor skipped, no limits raised. Reusing it requires a qualified product continuation, not SQL/reset. Per-record version lookup visits501parent versions; applied-history retirement is not called byengine and can stick behindUNKNOWNprefix. New non-native RED3 cases cover admission-preserved continuity and deterministic SQLiteVM lookup bound; product resourcefix not yet applied. Original429 separate gap-stage PASS, same retainedcursor and429/428history; recoverPID23628/native134363838109876075 RUNNING via normalAPIworker+gateway. Six-hour campaign never started.


### 2026-10-13T17:20:18.607Z — ordinary bytes PASS, client continuity OPEN

Ordinary732 replacement99aad… installed; actual1700files published but final client cut failed after751348ms with expired USN range. Separate authenticated readback1700SHA/465567744B/2201AVAILABLE/428historicalterminal operations preserved PASS239046ms; server unchanged. This is BACKEND_BYTES_ONLY_CLIENT_JOURNAL_GATE_OPEN, not full client acceptance. Own45min normal API/worker/gateway joined at deadline. Resource draft RED3→54/55(counter instrumentation failure)→8/8PASS; continuous capture/retirement and full qualification still pending. Original585 InboxCapacity remains unresolved, no blind reset/limit raise. Full evidence in .history; six-hour campaign never started.


### 2026-10-13T17:53:03.062Z — resource/pending-gap successor candidate

Resource draft addresses InboxCapacity backpressure, bounded exact parent alias lookup, continuous1s native capture during transfer, pagewise apply/retire with UNKNOWN raw preservation and pending scan/projection/coherence pins. Explicit repeated-gap request uses optionalcyclev6 link/native-bound evidence; capacity alone cannot replace a retained cursor. RED3+5+4 retained; correctiveflow11PASS, supersession4PASS, finaltarget127/128 with testFK setupfailure, corrected5/5PASS. OldCore095e refusesv6 before actualDB/WAL changes; WAL-awarev5rollbackPASS. Frozen223inputs/37owned186protected/exactreverse37/PDB98/Core9b3266bc…; full1024 RUNNING on186exactruntimefiles. Prepared original585 successor360ca5… supersedes283fc… with same585 originals; not yet executed. Ordinary732 backend1700SHA remains PASS, client current gate and installed-chain lineage composition remain OPEN. Full details .history. No six-hour campaign.


### 2026-10-13T18:11:50.676Z — resource full closure и исходное восстановление

Resource cohort731a5b47-95f4-4280-a41b-24b8feecbad4/Core9b3266bc… завершил1024/1024 tests PASS0skip за11m13s. Explicit applied-prefix retirement исходного585 profile:1558753records/236930456bytes,435601UNKNOWNraw/hash unchanged,192000unapplied tail retained, original cursor/gap и585immutableoperations сохранены. Actual successor recovery начат отдельным bounded step; current acceptance ещё OPEN. Новый regression RED подтвердил defect transitive ownership после второй installed replacement; исправление живого кода ещё вне accepted resource cohort. Six-hour campaign не запускалась.


### 2026-10-13T18:42:33.897Z — installed lineage accepted; current runs remain open

Core00a3987ae0cba509e02382d0c8df033dcd507c6841905f592c3c73c7afd3e5fc,cohort9fe66a15-b132-4951-a965-f0247521cad7:41targeted+1030fullPASS0skip,225sources40owned185protected/reverse40/PDB99. Повторные installed subscriptions могут квалифицировать исходный immutable file/folder receipt через bounded ancestry; текущие bytes/R/CAS всёравнообязательны. Resource2 original585 currentrun остановилсянаJournalGapпосле1183newpublications640476ms;618rawrecords/93936B,неcapacity. Rawfailureи39file/1755900783Bstoppedcopy сохранены,585originalsexact. Ordinaryновыйgen3recoveryRUNNING наacceptedCore, old2630rows/results сохранены. Original585nextgen4driver preparedonly. Windows eligibilityv6historyпокаdraftRED, ordinaryHTTPS/WPF/finalpackages/performanceиостальныеэтапыOPEN. Six-hour campaign не запускалась.


### Уточнение 2026-10-13T19:12:59.382Z: источник повторного USN gap

Ordinary gen3 PID32704 завершён с FAIL: trace18:46:52UTC доказал OSFirst21055406080 > cursor21055306232; retained2630previousrows/results unchanged. Current1647files451900941B captured,0uploaded/0published,ACK не достигнут. Stoppedbackup20files57756388B,4770workrows,quick_checkOK. Изолированный тест установил генерацию лишних USN при закрытии последнего SQLite connection:4096records после pool eviction438520USNbytes против2240с живымpool. Session-owned readonly connection без transaction уменьшил growthдо2048B и прошёл PASSIVE checkpoint/disposal/reopen. Новая frozenCore00980d65…:228sources43owned185protected/PDB100/186runtimefiles,3targettestsPASS; full1037 покаRUNNING. Fullqualification и повторactualclients ещёоткрыты. Windows installed-supersession admission исправлен и21testsPASS. Sourceeligibility не закрывает оставшийся Windows cross-scope history gate, HTTPS иpackage acceptance. Шестичасовой прогон не запускался.


### Принятие 2026-10-13T19:26:59.013Z: SQLite lifetime

Когорта 67fe4963-91ba-4c94-9820-5a2b21a85ca5, Core 00980d65f2d4f92a8139acbf53d3d79bf3a82076dc76ac0cc4b92c98832551a5: **1037/1037 PASS, 0 skipped**. Frozen228sources/43owned185protected; CorePDB100, testsPDB74 с12Windows sources;186runtimefiles. Исправление удерживает SQLite connection в пределах owned session без read transaction и предотвращает WAL/SHM churn после pool eviction. На этой сборке запущен ограниченный original585 recovery, PID31664/native134363930192414693, request90e707…; новая scope0027e0353aa3498989935abe9e28fe3c. На19:26UTC cursor успевает за OSNext, gap отсутствует; current ACK ещё открыт. Ordinary4770 recovery и runtime72a… подготовлены, не запущены. Предыдущий runtime6fe… завершился по45mindeadline. Шестичасовая кампания не запускалась.


### Original Neptune закрыт ограниченно, 2026-10-13T19:43:19.966Z

Core00980d65…/когорта67fe4963…: recovery PID31664 завершён647937ms с current ACK/pending0,1700files465567744B captured,430new publications117149703B. New PID18128:1654ms, NoWork,0captured/received/published bytes/files. Authenticated readback19:38:35UTC:1700SHA465567744B PASS за193244.8ms,2201AVAILABLE,586старыхserveroperations unchanged; server before/after unchanged. Stopped private snapshot34files1755592680B/quick_checkOK,3882previous work identities/results preserved,6082total workrows,current active0. Новый current scope0027e0353aa3498989935abe9e28fe3c, request90e707799cc9481999631aa4c5bd2134. Ordinary PID33600/native134363937709726518 ещё выполняется через normal runtime72a…; отдельный лишний gap-stage отказал readonly, поскольку oldvalid уже0, и сохранён в журнале. K10/deep и Windows service/HTTPS/packages ещё не закрыты. Шестичасовой прогон не запускался.


### Продолжение 2026-10-13T20:10:22.928Z: исходные K10/deep и новый retained FAIL

Оба исходных Windows profiles прошли K10(ровно10files861822B),newdeep(1file4096B/3dirs),new-processrepeat(0source/data bytes) на accepted Core00980d65…. Ordinary дополнительно прошёл1701authenticatedSHA/465571840B с сохранением2200старых серверных операций. Original независимыйreadback покаRUNNING. K10 после >5min паузы включал штатный cursor-expiry snapshot и не является чистым performance N0.

Pluto K10/deep публикации и readback прошли, но следующийrepeat сохранил отказ для deep.bin: baseline publication-end sequence8956 сравнивается с leaf-event8951 при квалифицированномcut8956. Исходный контейнер остановлен, rawFAIL и state-before сохранены. Исправление и новая когорта ещё не приняты. Windows retained-history resume targeted19PASS; полный1047наfrozenCore1a4c7ca6… ещёRUNNING. Все детали и входные/выходные гейты — в журнале; шестичасовой кампании нет.


### Продолжение 2026-10-13T20:29:28.245Z: сохранённый Pluto FAIL исправлен; Windows1047 и bundle

Pluto publication-cut cohort79bff022…: regression RED→GREEN,240 full race PASS/11existing skips,vet/release/UID gates PASS. Original same-state repeat на новом бинарнике9d093de5… прошёл:1701verified/adopted,0uploads/data bytes/errors,2215oldoperations exact,0pending; контейнер остановлен. Полный source rehash465571840B остаётся, A02 performance OPEN. Оба Windows после K10/deep прошли независимые1701SHA и WAL-aware backups со старой immutable history. Новый Neptune Core1a4c7ca6…/cohort610a43fe… прошёл1047/1047безпропусков. Common WPF release publish/MSI/ZIP payload identity и PDB101Core+20WPF PASS; native install/ordinary HTTPS/production release OPEN. Шестичасовая кампания не запускалась. Подробные входные/выходные гейты и raw links сохранены в журнале и .audit/2026-10-13/sync-revalidation-095229.


### Продолжение 2026-10-13T20:46:00.143Z: Pluto private read amplification

Когорта03ec6853…167sources/6owneddelta/161protected/exactreversePASS:244fullracePASS/11existing skips,vet/release/actualUIDgatesPASS. Originalsame-state repeat на6b511efa…:1701files,0uploads/errors,2215immutableoperations exact,0pending,59702ms; source465571840B/private465571840B. Private validation чтение сокращено вдвое общей lexical областью sealing+consumer с heldreadonlydescriptor; source/transport hashes и CAS/receiptchecks сохранены. Originalcontainerостановлен/joined. A02,normaldaemon и matchedN0 остаютсяOPEN; не productionrelease. Evidence: .audit/2026-10-13/sync-revalidation-095229/pluto-capture-scope-release/original-qualification.json.


### 2026-10-13T21:56:34.574Z: серверная часть S07 — ограниченная приёмка

Когорта [da1cb268-4aa7-4001-b14f-3a3511177744](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/small-batch-server/cohort.json): **123 targeted/PG/HTTP/recovery + 306 common tests PASS, 0 skipped**; lint/API types exit0. Frozen650 sources,17owned/633protected, exact reverse. В актуальный capsule включены две неизменённые0057 migrations, ранее отсутствовавшие в сокращённом sources-list; их хеши совпали с прежней fair-cohort.

Additive0061 хранит неизменяемые transport declarations (source generation/identity/rules и полный исходный V2 intent), не заменяя operation_journal/receipts. Регистрация500items не создаёт upload sessions. POST small-batches/{prepare,status,data}: multipart/related,≤500items/32MiB useful data/4MiB plan; один256KiB file buffer,≤4HTTPrequests, прежний≤4temp sessions. Authority проверяется до чтения body и вновь в каждом SQL command. Таймаут входа конечный; backend operation при cancellation завершается/фиксируется до освобождения слота.

Actual local PG+HTTP:500публикаций, lost202/status/повтор без изменений квитанций; обрыв второй части сохраняет первую и повторяет только missing original; zero-file, bad SHA/epilogue, отдельныйCAS conflict, device revocation, изменённыеgeneration/batch,4stalled requests→429/Retry-After и освобождение слотов, SQL lock timeout→429 без partial registration. Same-cut pg_dump→отдельныйpg_restore: **24metadata members exact**; guards/counters/used rollback/truncate и automatic recovery refusal проверены.

Приёмка ограничена отдельно подключаемым adapter и local backend. Normal API/worker deployment manifest с новым fixed function, SFTP batch, клиентские batchers/age flush, mixed-load и ≥15% throughput/p95≤+20% economic gate **OPEN**. Public small-file capability и автоматическое пакетирование не включены. MISSING означает отсутствие принятой upload session; оно не гарантирует будущийCAS. Transfer с неопределённым исходом backend остаётся unresolved. **Шестичасовой прогон не запускался и запрещён без отдельного явного указания.**


### 2026-10-13T22:15:14.216Z: S07 подключён к versioned ordinary factory

Когорта [bc851890-b743-4ab2-b1f9-ae46a7ea038b](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/small-batch-runtime/cohort.json): manifest/qualification v2 требует семь pinned SQL functions и отдельный batch transport proof; v1 сохраняет прежние шесть функций и не получает registry. Действуют прежние ACTIVE binding, credential/backend checks и maintenance boundary. Обновление populated roots не выполнялось.

13 manifest tests и 308 common PASS без пропусков; actual local v1/v2, SFTP v2 для обоих типов устройств, zero-file, lost ACK→status, immutable replay, peer/direct-SQL denial, backend readback PASS. Actual AppModule без provider overrides PASS. Types/lint exit0 после сохранённого test-only lint FAIL. 650 sources / 5 owned / 645 protected, exact reverse. Все новые fixture DB/roles/subdirectories очищены после PASS; собственный clone PG остановлен, volume сохранён.

Приёмка ограничена серверным transport path. Клиентские batchers/shared spool/age flush, worker mixed-load и economic gate всё ещё OPEN; публичные features не включают auto-batching. Шестичасовая кампания не запускалась.


### 2026-10-13T23:06:13.487Z: Neptune S07 — protocol/state/native aggregate приняты ограниченно

Строгий клиентский wire module: [33f1eeba-ee94-4af4-8942-ffebde8cc4e7](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/neptune-batch-wire/cohort.json), Core b3c26bf78f3c7a6329f1f97144de804f345fb192f749da9355988f729e273fc5, **1095 full +69 targeted PASS, 0 skipped**. Full original V2 intent/CAS, ordered per-item receipts, exact int64 source generation, Unicode, malformed JSON и mismatched original outcomes проверены; C#→TypeScript original-intent fingerprint совпал.

Optional state/native spool: [e8d08b8b-5c5b-4b4d-80be-81b2bf4c9ac2](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/neptune-batch-state/cohort.json), Core 19ae5be34f3f432d3b3e0264d61b5f2ad8323340ecf1a97721d25c9e6182a18e, **1112 full +65 targeted PASS, 0 skipped**. 236 source pins, delta11owned/225protected/exact reverse, PDB105Core+77tests (12Windows), runtime186files. Формат7 устанавливается только отдельным qualified caller; обычные профили4/5/6 не мигрируют. Прямые4/5/6→7 сохраняют WAL-aware backup и original history; старый frozen v6 бинарник отвергает все три копии без изменения DB/WAL.

Persisted plan связывает wire source_generation с immutable work_no, source_identity с SHA256 native capture proof; local_cycle_work сохраняет исходные CAS/UUID/receipts и остаётся источником истины. Aggregate ограничен нынешними четырьмя data workers, общими spool inventory/quota; нехватка дополнительного места даёт немедленный individual fallback. Однократная native file identity фиксируется до копирования; проверяются SHA256 частей/целого. Неизвестная публикация удерживает пакет. Cleanup проходит durable phase и удаляет проверенный native handle; подмена файла/изменение bytes отказывают. Original per-file spools сохраняются для fallback.

**OPEN:** включение в engine, qualified capability negotiation, history recovery агрегатов после scope replacement, matched economics и Pluto batcher. HTTP multipart/age250ms+1000ms scheduler реализуются следующей отдельной когортой; эти изменения не входят в указанную frozen сборку. Публичное auto-batching выключено. Six-hour campaign не запускалась и по-прежнему требует отдельного явного указания оператора.


### 2026-10-13T23:54:54.332Z: Neptune S07 — native engine и actual HTTP/SFTP recovery

Neptune engine cohort **95693262-1327-42e0-a88e-8f4c9ed650dc**, Core **0426183234e5943a072a4b289249140b4ca032fb8ea2d363dc932b0de6b97026**: **1149 full PASS / 123 targeted PASS / 0 FAIL / 0 SKIP**. Frozen245sources,10delta/235protected/exactreverse,PDB110Core+81tests/12Windows,186runtime. Packet dispatcher использует bounded age queue, durable original operations, optional v7 aggregate и full per-item receipts; currentL/B/R и dirty generations сохраняют прежнюю проверку. Capability negotiation явная, default auto-batching выключен. Historical cleanup разрешён только через exact installed replacement lineage и terminal original receipts.

Saturn capability cohort **11030096-0923-41a7-a703-5986e5aee5b7**:650sources/3delta/647protected/exactreverse;types/lint,13manifest и local-v1/local-v2/SFTP-v2 composition PASS. Отдельный authenticated endpoint выдаёт exact binding/device/backend/qualification receipt/limits только в v2; v1 сохраняет404 и прежние публичные features.

Actual network cohort **59398be8-6c5e-4d7f-8c22-81f10c79f12e**: public C# Core transport→ordinary API+worker mains→SFTP,319production sources/498emits без provider overrides.16files/1052676B,4packets,zero/Unicode/256KiB; cold restart0source/0publication. Два abrupt client exits(73) после actual prepare/data ACK до записи engine receipt, recovery в других PIDs и том же scope сохраняет20/24 originals и captured0. Lost-data:2049B уже опубликованы и не переданы повторно,2053B отсутствующих originals переданы.84authenticated file readbacks в4проверках; итог24files/1060880B SHA exact.7different client PIDs; repeated0capture/0publication;spools очищены. Own API/worker joined, clonePG stopped, unique fixture retained. Native rights — audit restricted medium; network loopbackHTTP, не обычный WindowsSyncService HTTPS.

**OPEN:** optimized batch-status/subset rebatching (следующий draft отдельно), matched economics ≥15% throughput/p95≤+20%, Pluto packet client, normal Windows HTTPS/native MSI, остальные PERF-07/08/09 gates и общий mixed qualification. Не распространять1149PASS на последующий batch-status draft. Подробные причины/input/output/tests в .history/2026-10-13-sync-implementation-revalidation.md; raw evidence в .audit/2026-10-13/sync-revalidation-095229/batch-network. **Six-hour campaign не запускалась и требует нового явного указания оператора.**


### 2026-10-14T00:36:56.340Z: Neptune batch-status recovery и Pluto batch transport

Neptune cohort [48f42ca6-6aed-4497-942e-d3c833d64625](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/neptune-batch-status/cohort.json), Core `2bd26c63bba622f1f1dc153d180b31fdc0896b2f7d653131965789e856e3d359`: **1154 полных и 128 целевых тестов PASS, без пропусков**. Восстановление уже сохранённых Attempted-пакетов запрашивает один batch status, проверяет весь состав и исходные receipts. Ответ служит подсказкой для прежнего guarded recovery: native capture/spool, source generation и L/B/R проверки сохраняются. Недоступная capability или конкретный batch_missing позволяют перейти к индивидуальному восстановлению; известный server UUID запрещает принятие ответа MISSING. Отдельная actual HTTP/SFTP когорта 59398be8… остаётся доказательством для предыдущего Core04261832…; этот новый Core ещё не прошёл её повторение.

Pluto wire cohort [117aba20-ed6b-48ae-af05-85ea540a24ce](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/pluto-batch-wire/cohort.json): **250 full race / 6 targeted PASS**, 11 прежних environment/scale skips, vet exit0. Строгие manifest/capability/outcome относятся к существующим immutable originals, с исходными operation IDs, capture identity и точным Int64 generation.

Pluto transport cohort [e5d96ebe-633c-4e17-931e-8dc2498c72a4](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/pluto-batch-transport/cohort.json): **255 full race / 11 targeted PASS**, 11 прежних пропусков, vet exit0; 172 sources, 3 новых / 169 неизменённых, exact reverse PASS. Поток multipart ограничен блоками 64 KiB, каждый SHA проверяется до следующего delimiter, файл принадлежит вызывающему коду; отмена присоединяет текущий reader, автоматического replay нет. Go frame 265970 B / 263169 полезных B принят frozen TypeScript receiver блоками 1, 17 и 65536 B. При усечении последнего элемента сохраняются 3 completed и 1 interrupted. Это проверка транспорта, не публикации через реальный backend.

**Открыто:** Pluto optional state v7/native aggregate/scheduler и подключение к normal daemon; этот draft нельзя считать частью принятой transport-когорты. Также остаются Neptune actual network на Core2bd26c63…, subset rebatching, matched throughput/p95 gates, Windows normal HTTPS/native install и остальные ранее перечисленные PERF-07/08/09/11 задачи. Автоматическое включение batching не разрешено экономическим гейтом. **Шестичасовой прогон не запускался и требует нового явного указания оператора.**


### 2026-10-14T01:15:46.619Z: Pluto optional state и native aggregate

State cohort [a4555f80-b53f-47c4-b3f9-5567895117b2](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/pluto-batch-state/cohort.json): **261 full race /17 targeted PASS**, 11 прежних environment/scale skips, vet0. Версия7 включается отдельным caller; default Open/HTTP остаются на6. Bounded references (64 records/4 live groups) связываются с прежними SUBMITTED originals и общим plaintext quota. Migration сохраняет операции/B/dirty и WAL-aware backup. Actual frozen v6 executable отказывает в чтении7: основной DB и существующий committed WAL byte-exact; старый readonly SQLite может создать пустой WAL и32KiB SHM либо изменить coordination bytes SHM. Это ограничение явно сохранено в raw failures; полного отсутствия sidecar effects не заявляем.

Native cohort [447a1350-84ea-4ad8-ac60-1b94a6af794f](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/pluto-batch-artifacts/cohort.json): **270 full race /26 targeted PASS**, 11 прежних skips, vet0; отдельно9native tests под actual UID65534 PASS.177sources/4delta/173protected, exact reverse PASS. Private0700/no-follow directory и Linux statx birth identity защищают принадлежность агрегата; оригинальные snapshots остаются для fallback. Full per-file/aggregate hashes, fsync, durable ATTEMPTED-before-network, joined readers/Close, cleanup через DISPOSING/quarantine/GONE; неизвестные файлы сохраняются. Проверены14crash points, замены, hardlink/symlink,4active readers и отмена. Actual native captures0/1/1024/262144B →263169B aggregate →265979B Go frame принят frozen TypeScript parser в chunks1/17/65536; truncated tail даёт3complete/1interrupted. Это parser interoperability, не actual backend publication.

**Открыто:** следующий Pluto dispatcher draft, scheduler/capture integration/normal daemon; actual Saturn HTTP/SFTP, matched economic gate и ранее перечисленные задачи. Native270PASS не распространяется на dispatcher draft. Default auto-batching выключен. **Six-hour campaign не запускалась и требует отдельного явного указания.**


### 2026-10-14T01:33:43.408Z: Pluto optional packet dispatcher

Когорта [21212db9-0f3f-4cd5-b756-dd83a8a1553f](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/pluto-batch-dispatch/cohort.json): **278 full race /34 targeted PASS**,11existing skips,vet0;17native+dispatcher suites отдельно повторены под actual UID65534.179sources,3delta/176protected,exact reverse PASS.

Dispatcher использует explicit capability и global admission, фиксирует ATTEMPTED до первого сетевого эффекта. После interruption сначала выполняется batch status; только exact structured404batch_missing без известных original UUID допускает prepare. Весь ordered response проверяется до изменений. UUID association и full original receipts проходят прежние BindHTTPUpload/Refresh/AckCaptured; новое поколение и invalidated source witness сохраняют dirty. Published bytes не повторяются; missing-only subset использует прежние operation IDs и ограничен одним дополнительным пакетом на вызов. Accepted partial original продолжается индивидуально с прежним server UUID; conflicts остаются unresolved.

Actual loopback HTTP fixture с native aggregate/reopen проверил lost prepare/data/partial, ACK crash, mixed accepted+missing, conflict/singleton, malformed order, known-UUID MISSING и cancellation join. Это local receiver fixture с полными catalog receipts/feed, **не actual Saturn PG/SFTP**. Начальные test-only compile/restart/cancellation failures сохранены в audit/log.

**Открыто:** age queue (отдельный draft181sources), capture/CLI integration, normal daemon, actual backend qualification, matched economics и остальные ранее перечисленные этапы.278PASS не распространяется на queue draft. Auto-batching default off. **Шестичасовая кампания не запускалась и требует отдельного явного указания оператора.**


### 2026-10-14T02:29:26.453Z: Pluto age queue, общий бюджет и отдельный CLI

Приняты ограниченные инкременты: очередь [56bb8375-599f-4efb-9367-8441fe890d55](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/pluto-batch-queue/cohort.json),284full/40targeted; общий бюджет [f67ee8f8-40da-4c23-84de-efa9b5e093ed](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/pluto-batch-budget/cohort.json),291full/47targeted; композиция capture/CLI [c121c387-b320-4af7-84df-55bfc0b68bc7](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/pluto-batch-engine/cohort.json),**297full race/53targeted PASS**,11existing environment/scale skips,vet0. Engine188source pins,8owned/180protected exact,reverse PASS;33native/state+3admission suites повторены под actual UID65534.

Explicit isolated config small_batch_mode=bulk/changes подключает250/1000ms oldest-age очередь,2workers/2queued groups/1current, общую256MiB plaintext admission и native aggregate. Источник закрывается до enqueue; крупные файлы ждут drain без открытого source FD. Default и отсутствие capability сохраняют HTTP schema6. Если optional mode отключён после interruption, saved v7 aggregates освобождаются с проверкой originals, восстановление продолжает individual protocol. Восемь actual CLI processes в каждом наборе покрыли mixed0/1/1024/262144/262145B, repeat, lost response/recovery и disabled-mode recovery; original IDs сохраняются, recovery source_reads0, jobs/readers/temporary reservations join. Это full-receipt loopback receiver fixture, не actual Saturn/PG/SFTP.

**Ограничение текущей приёмки:** controlled engine cases приняты; inspection после них выявил необходимость atomic native namespace lifecycle и удаления terminal group references в пределах одного большого прохода (лимит64). Подготовлен следующий189source draft и отдельные deterministic overlap/140files70packets regression tests. Массовая загрузка не принята до их закрытия. Ordinary daemon, A02zero-source-read continuity, actual backend, matched ≥15% throughput /p95≤+20% и остальные этапы остаются открыты. Automatic batching/release не включены. **Шестичасовой прогон не запускался; требуется отдельное явное указание оператора.**


### 2026-10-14T02:58:00.106Z: Pluto native namespace и последовательность70пакетов

Когорта [ffa83bf1-23bb-49fd-9aea-42d5707b83ef](C:/.projects/exocortex/.audit/2026-10-13/sync-revalidation-095229/pluto-batch-lifecycle/cohort.json): **299full race PASS; earlier55targeted PASS on the same production code**,11existing full skips,vet0;35syncstate+3admission suites повторены под UID65534.189source pins,4owned/185protected exact,reverse PASS. После первого full повторён исправленный test-only gate:140файлов могут образовать68пакетов и4individual по1s age; точное70не является продуктовым требованием. Проверяется переход за64refs, все140publications и нулевой остаток. Production CLI hash совпадает с прежним green target. Сохранены исходные failures: четыре controlled native interleavings и140file scan с8failed/reconciliation items.

Закрыты два ограничения предыдущего controlled engine gate: локальные native create/remove/compaction и проверка directory namespace теперь согласованы RW-lock; immutable network callbacks не удерживают его. После каждого joined packet удаляется bounded page≤16terminal references только при доказанном отсутствии native bytes. Реальный один проход140files/>64packets завершился, source_reads140, batch rows/aggregate charge0. Existing4native readers и original-ID CLI restart/disabled-mode cases повторно PASS. Это проверка корректности и ограниченности указанного сценария; matched throughput/latency benchmark и actual Saturn/PG/SFTP для нового Pluto CLI ещё не закрыты. Ordinary daemon и автоматическое включение оптимизации остаются отдельными задачами.

Для Neptune Core2bd подготовлен продолженный network fixture на прежних24files/profile/origin с отдельными status-prefixed результатами; до фактического выполнения он PREPARED_ONLY. **Шестичасовой прогон не запускался; требуется отдельное явное указание оператора.**
