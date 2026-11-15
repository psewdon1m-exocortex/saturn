---
title: "Шестичасовая приёмка новой синхронизации Saturn Neptune Pluto"
date: "2026-10-12"
status: "PLANNED — запуск только после завершения реализации и обязательной приёмки"
---

# Шестичасовая приёмка новой синхронизации

> **Обновление15октября2026:** актуальные правила закреплены в [ENDURANCE_6H_RUN_RULES_2026-10-15.md](C:/.projects/exocortex/saturn/docs/implementation/ENDURANCE_6H_RUN_RULES_2026-10-15.md). Они расширяют область до пользовательских сценариев Saturn/Neptune/Pluto, разрешают локальный Windows ПК и полную предварительную очистку Docker с сохранением работающего движка, задают нарастающую параллельную нагрузку и разрешают repair/retest последнего начатого цикла после6h. Противоречащие им ограничения ниже являются историческими. Прогон пока не запущен.

Этот прогон назначен пользователем после завершения реализации. Целевая область — Saturn + установленный Neptune Windows + Pluto на локальном изолированном стенде, с измерением эффективности против исходной когорты. Текущие unit/HTTP проверки и прежний 12-часовой прогон не заменяют эту приёмку. На момент создания плана шестичасовой тест и его автоматизация не запущены.

Основной [план реализации](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_IMPLEMENTATION_PLAN_v1.0.md) и [матрица](C:/.projects/exocortex/saturn/docs/implementation/NEPTUNE_WINDOWS_SATURN_PLUTO_ACCEPTANCE_MATRIX.md) определяют готовность. Требования A01–A42 и D1–D9 берутся из [спецификации v1.0](C:/.projects/exocortex/saturn/docs/NEPTUNE_SATURN_SYNC_PERFORMANCE_SPEC_v1.0.md).

## Условия запуска

| Gate | Требуемое доказательство |
|---|---|
| Новая система реализована | Активные initial и repeat пути обоих клиентов, capability negotiation, подтверждённые серверные writers/feed/recovery; отсутствующие обязательные механизмы не выдаются за готовые |
| Регрессии | Все применимые этапные functional, integrity, interaction и migration checks PASS; воспроизводимые зависания устранены по первичной причине |
| Windows runtime и установка | Engine выполняется на настоящем Windows с изолированными тестовыми roots/state/credentials и тем же Core, что в MSI/portable. Native MSI installation/update/WPF UX требует отдельной Windows-среды и учитывается отдельным gate; build/Core execution не дают ему PASS |
| Pluto | Настоящий daemon/CLI из квалифицированного локального bundle, включая новый linked runtime, notices и update/rollback compatibility |
| Источники | Frozen revisions + исходные dirty hashes + отдельный patch; SHA каждого фактически запущенного артефакта; capability/config/migration identity |
| Контроль времени | Короткая проверка scheduler, resume, stopped admission, last-round drain и независимого watchdog до запуска шестичасового окна |
| Изоляция | Только тестовые roots/profiles/credentials/loopback services; inventory каждого ресурса и точный run label |
| Данные и бюджеты | Проверенные deterministic dataset manifests, достаточное место для старой/новой когорты и rollback; объявлены лимиты CPU/RAM/I/O/сети/очередей |

Если функциональный gate открыт, продолжается реализация или подготовка стенда. Тест foundations с выключенным delta engine не считается испытанием готовой новой синхронизации. Production не обновляется; исходный paused mapping пользователя не мигрируется, не возобновляется и не используется как нагрузка.

Пользователь подтвердил, что отдельной Windows VM/тестового ПК нет, доступны только WSL2 и Docker. Поэтому native MSI installation/update/WPF UX остаётся UNVERIFIED и не блокирует назначенный endurance по реально доступному Windows engine после завершения функциональных gates. Это ограничение стенда, а не успешная native qualification: в manifest запуска и финальном отчёте указываются точный entrypoint, связь его Core bytes с bundle, проверенные Windows capture/journal APIs и непроверенные installation/autostart/UX paths. Установка или запуск второго пользовательского клиента на рабочем ПК не используется как обход этого ограничения.

Пользователь 2026-10-13 разрешил снижение тестового порога свободного места до **10 GiB**. Новые admission/monitor/runner настройки применяют этот порог явно; память ≥8 GiB, суммарный test Docker CPU ≤4.5, BelowNormal/affinity15 и общий Gateway ≤8 MiB/s сохраняются. Исторические frozen проверки с порогом40 GiB и продуктовые значения по умолчанию не переписываются. Для кампании требуется отдельно квалифицированный controller policy successor с новым порогом; старый S2 manager сам по себе ещё не подтверждает эту настройку.

## Время и управление

После preflight и сборок один раз фиксируются `startedAt`, `admissionDeadlineAt = startedAt + 6 hours`, монотонное elapsed time и идентичность run. Ремонты и простои входят в это шестичасовое окно; resume сохраняет исходную границу, нового окна не создаёт.

После `admissionDeadlineAt` не запускаются новые rounds, fault campaigns или retry. Последний round, действительно начатый до границы, заканчивается с итоговой проверкой целостности и cleanup. Это явное исключение пользователя: wall time может превысить шесть часов только на завершение этого round. В отчёте отдельно указываются шестичасовое окно, активная нагрузка, простой, время последнего round после границы и cleanup.

У каждого round до допуска сохраняются dataset/cohort identity, список операций, `startedAt` и квалифицированный по короткому прогону конечный timeout. Последний round не расширяет свой список работ после границы. Drain не разрешает бесконечного зависания: превышение собственного timeout означает FAIL с сохранением primary evidence; независимый watchdog останавливает только подтверждённые ресурсы прогона. Менеджер и watchdog идентифицируются не одним PID, а PID + Win32_Process.CreationDate + полной командой с точным run path.

Мониторинг каждые 30 минут создаётся через Codex heartbeat при фактическом запуске. Менеджер непрерывно собирает метрики и сам останавливает admission по времени, поэтому расписание heartbeat не является часовым ограничителем. Файл состояния монитора исключает повторные уведомления. Сообщения пользователю — новый подтверждённый FAIL, зависание/остановка, исправление и повторная проверка, новая когорта либо завершение.

Подготовлен отдельный [timing contract](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/admission-window.mjs) и [его проверки](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/admission-window.test.mjs): точная граница6h, завершение последнего round, timeout зависшего drain, downtime/resume без нового окна, clock reversal и чужая completion identity. Это чистая политика времени, она не запускает нагрузку и ещё не квалифицирует manager/watchdog/heartbeat integration.

## Парное сравнение

| Когорта | Содержание и назначение |
|---|---|
| B0 | Восстановленные исходники до этой реализации, включая существовавшие пользовательские dirty changes из source inventory; реальные бинарники и hashes. Это основное сравнение до/после |
| B-release | Последний release только при подтверждённой фактической release identity; отдельный результат, не выводится из текущего HEAD |
| N0 | Завершённая новая реализация после обязательной приёмки |
| N1… | Каждый ремонт во время endurance: новый frozen diff/build/config identity и перечень повторённых checks; результаты N0 не переписываются |

Сравниваются одинаковые dataset manifests, hardware/backend/RTT/channel caps, CPU и queue limits, одинаковые content read-back и namespace/history invariants. Порядок старой/новой когорты чередуется; cold и warm runs фиксируются отдельно. Кэш нельзя очищать глобально на рабочем ПК. Для первичной загрузки используются новые изолированные roots; для repeat — одинаковое достигнутое и проверенное состояние. Штатная архитектурная экономия hash/requests в новой системе допустима только при доказанной continuity/cut; отключение проверки целостности ради выигрыша запрещено.

B0 подготовлена в отдельном audit-каталоге: [source manifest](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/baseline-preparation.json). Восстановлены735 tracked files трёх pinned revisions и точно совпали23 hashes первоначальных dirty files. Три исходно untracked Saturn test/docs/script файла не имели полного initial byte inventory и исключены из этой source qualification; это явно отражено в manifest. Original WindowsSyncService/Core, CGO0 Pluto amd64/arm64 и исходный Saturn API/worker/workspace packages собраны в изолированном B0-build. [Saturn build1147 checks](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/baseline-saturn-build-result.json) подтверждает559 original+dirty hashes и локальные package links. [Actual original data-plane qualification](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/baseline-full-qualification.json) прошла local/SFTP с68 SHA readbacks/run и fresh repeat обоих исходных клиентов. Kernel/auth/discovery/whole main/worker/native installation остаются fixtures или вне этого короткого gate. [Диагностика](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/baseline-qualification-diagnosis.md) отделяет fixture repairs от продукта. Matched B0/N0 benchmark ещё не выполнен; один34-file sample/backend не является коэффициентом production ускорения. Это локальная исходная когорта, не подтверждённая production release identity.

Парные baseline/new samples входят в шестичасовое окно. Подготовка sources, compilation и короткая квалификация стенда выполняются до `startedAt`. Если большой исходный алгоритм не завершился в бюджете sample, сохраняются censored duration/progress/resources; нельзя подставлять ожидаемое время или объявлять speedup на основании незавершённого результата.

## Наборы и разнообразие нагрузки

Synthetic datasets содержат только тестовые данные. Поддерживаемая область и исключения фиксируются до запуска; Pluto сохраняет предел 256 MiB на файл и backup semantics. Набор за пределами лимита проверяет явный отказ и отсутствие повреждения, а не скрытое расширение лимита.

| Группа | Сценарии | Обязательные инварианты |
|---|---|---|
| Initial metadata | 1700/100k/500k entries, много мелких файлов, широкие и глубокие каталоги, пустые каталоги, Unicode/case/path collisions | Первый файл до конца scan; bounded RAM/queues/SQL effects; no files×depth requests; неподдерживаемые имена не перезаписывают соседей |
| Initial bytes | Нулевые файлы, смешанные размеры, поддерживаемые крупные Neptune files, малые Pluto files, одновременные roots | SHA/size каждого результата; received отдельно от published; spool/buffers/readers/concurrency ограничены |
| Steady state | Fresh no-change cycles, 1/10/100 changes, bursts во время bootstrap, equal size/mtime с другим содержимым | O(changes) при подтверждённой continuity; отсутствие per-file HEAD/full remote enumeration в normal mode; dirty generation не теряется |
| Namespace | Rename/move file/folder, subtree входит в root, delete/quarantine Neptune, источник исчез Pluto | Условия по актуальной версии; неизвестное не равно absent; Pluto ничего не удаляет на сервере из-за отсутствия источника |
| Source races | Busy file, замена source/root/junction/symlink, изменение во время capture/upload, access denied | SOURCE_BUSY/blocked subtree сохраняется; no escape из root; partial scan не разрешает массовые удаления |
| Transport | Латентность/jitter, разрыв на create/chunk/complete, lost acknowledgement после publication, SFTP semantic missing и connection failure | Same-ID replay; исходная immutable receipt после чужой версии; отсутствие повторной публикации/потерянных задач |
| Process/recovery | Kill/restart клиента, API, worker и собственного backend на подготовленных durable boundaries | Тот же intent/checkpoint; итоговое содержимое и история; отсутствие необъяснимых temp/двойных versions |
| Index/journal | Watcher overflow, journal gap/reset/retention expiry, server epoch change, dirty cursor crash, snapshot interruption | Явная reconciliation; B/operations не стираются; cursor и work атомарны; incomplete snapshot не объявляется READY |
| Auth/concurrency | Revocation/rotation/rebind во время verification, foreign update, opposing move, одновременные readers/writers | Нет публикации вне актуальных прав/root; conflict вместо blind overwrite; SQL commits bounded; backend uncertainty сохраняется |
| Budgets | Заполненная ready queue/spool, low disk/RAM, bounded backend delay, fairness live vs bootstrap | Backpressure без deadlock; нет бесконечного роста; live updates не голодают; снижение только тестовой нагрузки |
| Upgrade | Legacy profile → new, paused-state preservation, interrupted migration, downgrade/refusal, portable ↔ installed, Pluto update rollback | Credentials/identity/bindings сохранены; один writer; нет слепого B adoption или удаления опубликованного |
| Compatibility | Legacy supported clients, Drop/backups/versions/restore/UI writes рядом с new sync | Общий mutation core и journal coverage; права и прежняя история не ломаются |

Rounds используют детерминированные seeds и перемешанный порядок. Fault injection воздействует только на собственные test processes/backend/resources. Нормальные загрузки, новые адресные изменения и readers идут одновременно; fault campaign ограничивается собственным root/component. Итоговые инварианты проверяются после восстановления, отдельный ожидаемый transport error сам по себе не равен FAIL.

## Метрики и критерии

| Измерение | Что сохраняется |
|---|---|
| Время | Scan/resolve/capture/hash/upload/verify/publish/reconcile отдельно; first ready/first publish; initial completion; fresh no-change и edit-to-publish p50/p95; recovery time |
| Работа | Discover/ready/queued/received/published/ACK/conflict/failed counts; уникальные operation IDs; HTTP по method/route/status; metadata queries и directory work |
| Bytes | Source bytes прочитано/hashed, sent/received/published, повторные и retransmitted bytes; backend verification reads; полезная скорость |
| CPU/RAM | CPU seconds и interval load по API/worker/client/backend; peak private bytes/RSS/managed heap; runtime отдельно от build/container page cache |
| Диск/сеть | Read/write bytes и latency, SQLite DB/WAL/spool peaks, PG temp/locks/transaction duration, сеть test gateway; queue/job/reader high-water marks |
| Итоги | SHA/namespace/history, receipts vs outcomes, unresolved dirty/pending/UNKNOWN, orphan resources и cleanup ownership |

Критерии новой системы: ни одной необъяснимой потери/порчи данных или false success; ни одной потерянной dirty generation; подтверждённые публикации не повторяются после restart; recovery завершает либо явно блокирует работу без unsafe overwrite/delete; очереди и ресурсы остаются в лимитах. Для каждого injected fault есть ожидаемый переход и проверка результата.

Performance gates из спецификации сохраняются: fresh no-change p95 ≤2s без long-poll wait и 0 per-file requests; first publish ≤5s после ready при доступном ресурсе и до конца scan; малый edit-to-publish p95 ≤5s; engine memory на500k цель ≤384MiB и рост100k→500k ≤64MiB; metadata-bound initial цель ≥3× при равной целостности. При непройденной цели показывается bottleneck и реальная измеренная граница, строка не объявляется PASS. Число samples/variance, warming и ограниченность coverage указываются в отчёте.

## Разбор, ремонт и повтор

На каждом heartbeat читаются status, последние results/metrics, новые FAIL, terminal diagnostics, manager/round/API/worker/Neptune/Pluto tails, ownership и watchdog identity. Проверяются свежесть журналов, heartbeat/progress, deadlocks, disk/RAM budgets и фактические cleanup остатки.

1. Зафиксировать точный failed check, первичные logs/DB/counters и dataset/cohort/seed. Отличить дефект продукта от стенда.
2. Сохранить diagnosis и минимальное воспроизведение; добавить релевантную regression и выполнить её.
3. Исправление продукта внести в соответствующий живой проект с сохранением чужих dirty changes, затем в новую frozen когорту. Сохранить diff, hashes, tests и смену cohort identity.
4. Повторить failed scenario с теми же seed/conditions и затронутый common interoperability/integrity smoke, если admission ещё открыт.
5. После трёх одинаковых падений без новой причины/исправления остановить эту нагрузку и сообщить препятствие. Blind retry не считается восстановлением.

После шестичасовой границы repairs могут завершать диагностику последнего round, но не создают нового stress round или новую шестичасовую попытку. Если исправление не успело пройти повтор, оно явно остаётся unqualified в итоговом отчёте.

## Изоляция, завершение и отчёт

Суммарный CPU container budget на этом ПК по умолчанию ≤4.5 CPU, node BelowNormal/affinity15, тестовый gateway ≤8MiB/s; финальный preflight фиксирует применённые limits. При free disk <40GiB или free RAM <8GiB manager уменьшает/останавливает только тест. Текущая большая Neptune синхронизация пользователя остаётся на паузе; если пользователь возобновит её, признаки помех требуют снизить тестовую нагрузку. Чужие containers/volumes/процессы, production и Downloads Neptune не изменяются.

Итог включает duration/load/downtime/tail, seeds и покрытие, успешные/неустранённые сценарии, операции/bytes/recovery, before/after time/resources/requests, миграции и все смены когорт. Cleanup сверяет exact ownership; monitor сохраняет результат и приостанавливает собственную автоматизацию через automation_update с сохранением её полей. Вывод о стабильности ограничен фактически выполненными сценариями и конфигурацией; недоступные native/backend cases указаны отдельно и не получают PASS.
