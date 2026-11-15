# Правила шестичасового прогона Saturn / Neptune / Pluto

Статус: **RUNNING** — запуск явно разрешён оператором. T0: **2026-10-15 02:17:32.103 +03:00**, граница новой admission: **2026-10-15 08:17:32.103 +03:00**. Последний начатый цикл завершается полностью. Актуальное состояние: `C:/.projects/exocortex/.audit/2026-10-15/endurance-6h/current.json`; журнал: `C:/.projects/exocortex/.history/2026-10-15-six-hour-run.md`. Самостоятельный контроль каждые 30 минут настроен в heartbeat этого чата, ID `30`.

Дата: 15 октября 2026, часовой пояс Europe/Istanbul. Этот файл закрепляет последние указания оператора и имеет приоритет над прежним планом шестичасовой приёмки в части области, стенда, ресурсов, параллельности и повторов последнего цикла. Исторические результаты не переписываются.

## 1. Цель и область

Основной приоритет — надёжная синхронизация, отсутствие потери правок, лишних локальных копий и повторных публикаций. Дополнительно проверяется обычная работа **всех трёх продуктов**, включая интерфейсы, owner upload/download, drop point, sharing, папки, версии, корзину, настройки и клиентский lifecycle. Unit tests поддерживают диагностику; они не заменяют пользовательские цепочки через настоящие клиенты/API/backend.

Порядок: **сценарий → проверка результата → при FAIL сохранение evidence → диагноз → исправление → повтор того же сценария и затронутых проверок**. Повторять до PASS либо доказанного препятствия; не объявлять незакрытую ошибку успешным итогом. Общий pipeline после каждой правки не запускается.

## 2. Время, запуск и завершение

1. Сборки, подготовка стенда, инвентаризация и проверки самого контроллера выполняются до T0. Подготовка не является шестичасовым прогоном.
2. При фактическом запуске один раз записываются runId, UTC/local T0, monotonic anchor и deadline=T0+21600секунд. Диагностика, исправления, сборки исправлений и простои внутри кампании входят в это окно. Resume сохраняет прежний deadline.
3. Цикл — заранее зафиксированный набор сценариев, данных, seeds и параллельных направлений. Только реально начатый до deadline цикл имеет право завершаться после deadline; резервировать всю будущую очередь как «начатую» нельзя.
4. На границе6h прекращается admission **новых циклов и новых ступеней нагрузки**. Все начавшиеся параллельные части текущего цикла проходят до итоговой проверки, включая необходимые исправления и повторы его упавших сценариев/затронутых checks. Новые независимые кампании после границы не добавляются.
5. Процесс не убивается просто из-за наступления6h. Зависание определяется отсутствием прогресса, допустимым временем конкретной операции и cancellation/join watchdog, а не удобным общим timeout. Сначала stack/dump/DB/progress evidence, затем FAIL и завершение только принадлежащих тесту процессов.
6. Три одинаковых отказа без новой диагностики/правки запрещают blind retry. Направление получает BLOCKED; другие независимые направления продолжаются. Ошибка общей целостности останавливает зависимые нагрузки. Финальный статус остаётся FAIL/BLOCKED, если причину устранить не удалось.
7. После deadline отдельно учитываются tail последнего цикла, repair/retest и cleanup. Не выдавать их за дополнительные шестичасовые окна.

## 3. Параллельность

| Направление | Работа | Изоляция |
|---|---|---|
| SYNC | Реальные Neptune Windows и Pluto, initial/repeat/edits/conflicts/no-duplicates | Отдельные profiles/roots/credentials; совместная нагрузка на общий квалифицированный backend только в отмеченных mixed сценариях |
| PRODUCT | Saturn browser+API: файлы, download/Range, drop, shares, trash, versions/settings | Свои ресурсы и browser contexts; scoped public links не отправляются людям |
| RECOVERY | Network faults, proxy/DNS, crash/restart, quota/backpressure, client update | Свои endpoints/экземпляр API для disruptive faults; при воздействии на общий backend — явный общий cycle barrier |
| CONTROL | Таймер, metrics, journal, hashes/readback, сборка/ремонт | Не добавляет нагрузочные сценарии за спиной dispatcher |

Независимые процессы/сценарии запускаются параллельно. Сборки одного дерева, replacement используемого binary, MSI update одного installation и faults общего backend сериализуются. Native hardlink/USN stress не совмещается с проверкой coherence на том же volume без явной совместной постановки. Ремонт даёт новую cohort identity; старые результаты сохраняют прежние hashes.

## 4. Стенд и разрешения

- Оператор разрешил локальный Windows ПК, включая замену старого Neptune новым при необходимости. Это снимает прежний blanket blocker «нет Windows-стенда».
- Оператор разрешил перед подготовкой **полную очистку текущего локального Docker Desktop**: containers, images, volumes, build cache, custom networks, включая старые данные других проектов. Очистка выполнена15октября, inventory сохранён. Docker Desktop, движок и WSL не выключать/не перезапускать; factory reset, unregister, offline VHD compaction не применять.
- Изолированные тестовые источники/profile/state обязательны. Разрешение использовать ПК/заменить приложение не означает использование рабочих vault как расходных данных. Default profile не сбрасывать, не пере-enroll и не возобновлять его прежнюю большую синхронизацию автоматически.
- Новый build проверяется обычным Windows entrypoint с отдельным `--profile`. Если потребуется замена используемой установки: остановка конкретного клиента, согласованная копия state и прежнего payload, inventory/hash, штатная установка, health/rollback. Нельзя копировать живую SQLite без согласованного backup.
- На локальном ПК разрешены проверки запуска/закрытия, pause/resume, isolated profile migration и portable/MSI/update при доступных правах. Наличие ПК само по себе не делает эти проверки PASS.
- Не отключать основной сетевой адаптер, не переводить ПК в sleep/reboot и не ломать канал удалённого доступа. Network/sleep faults моделируются в собственных proxy/processes/изолированном адаптере; настоящий системный sleep/resume не выдавать за проверенный, если он не выполнен.
- Физический reset/trim USN разрешён только на собственном отдельном тестовом volume/VHD при наличии средств и прав. Журнал C: не сбрасывать. При невозможности выделить volume этот подвариант остаётся BLOCKED.
- Public share/drop endpoints используют локальные fixture identities. Реальные Telegram/Gryphon сообщения людям не отправлять; локальный adapter/fixture не выдавать за живую доставку Telegram.
- Старые `verify-stage-*` не запускать вслепую: некоторые запускают общий pipeline, используют фиксированные порты, общие `.env`/compose state либо настоящий Storage Box. Брать нужные проверки и адаптировать endpoint/state под run. UI mocks дают только UI результат, не end-to-end PASS.

## 5. Обязательные пользовательские сценарии и критерии

Каждая строка получает в coverage ledger статус NOT_RUN/RUNNING/PASS/FAIL/BLOCKED и ссылку на доказательство. Сохранённый прежний PASS явно помечается reused, не считается новым выполнением кампании.

| ID | Действия | Приёмка |
|---|---|---|
| SYNC-01 | Первичная синхронизация обоих клиентов: файлы0B, текст/binary, Unicode, длинные имена/пути, пустые/широкие/глубокие деревья | SHA/size/пути и число объектов совпали; никакой ложной завершённости; ранняя публикация и ограниченные очереди |
| SYNC-02 | Повтор без изменений, restart и ещё один повтор | Новых content publications/captured bytes нет; server feed квалифицирован; нет per-file обходного HTTP вместо delta |
| SYNC-03 | Создать/изменить/дописать; изменение того же размера/mtime; burst saves | Последнее подтверждённое содержимое соответствует ожидаемому, g+1 не очищается ACK поколенияg |
| SYNC-04 | Atomic save delete→rename→create; временное исчезновение/lock, тот же файл на кириллице | Остальные файлы продолжаются; исчезнувший отложен; нет unsafe remote cleanup; после стабилизации сходится |
| SYNC-05 | Rename/move файла и дерева, изменение только регистра, перенос во время передачи | Сохраняется предусмотренная identity; нет лишней ветки/публикации, обходов parent/CAS и потери потомков |
| SYNC-06 | Local delete и исключение/возврат source scope | Neptune obeys guarded mirror/delete policy; Pluto сохраняет backup copies. Нет удаления чужого root/неподтверждённого subtree |
| SYNC-07 | Независимая правка на Saturn плюс локальная правка | Явный конфликт/предусмотренный outcome; remote winner не затёрт; baseline и обе пользовательские правки сохранены |
| SYNC-08 | Потеря ACK prepare/chunk/complete/seal; restart клиента с unchanged/changed/deleted source | Прежние original IDs/input/hash/upload offset; одна публикация; immutable captured bytes; новый source остаётся dirty |
| SYNC-09 | Несколько профилей/обоих клиентов одновременно | Раздельные credentials/bindings, общие resource limits соблюдены, нет starvation и cross-root effects |
| SYNC-10 | Pause во время работы, restart в pause, resume без нового FS event | Pause сохраняется; in-flight drain описан; очередь продолжает прежние originals после resume |
| SYNC-11 | Enrollment/reconnect, token expiry/revoke, scoped403, proxy407 | Credential не теряется от transient error; revoked scope закрыт; другой scope не разблокируется ошибочно; нет DAV downgrade |
| SYNC-12 | Cursor expiry/gap, частичный snapshot, migration/adoption со сменой binding | Snapshot атомарен; originals/история сохранены; повторный apply идемпотентен; wrong binding/receipt отклонён |
| DUP-01 | Локальный manifest до/после каждого SYNC шага + watcher trace: имена, file ID, size, SHA | Neptune/Pluto не создают неожиданные `(2)`, `(3)`, `copy` и другие файлы; нет незаявленных локальных rename/write/delete |
| DUP-02 | Исходно есть `example.md` и законный `example (2).md`; затем atomic saves/restarts/сбои | Оба исходных файла сохранены правильно; ни один не «дедуплицирован» по имени. Новые файлы разрешены только manifest сценария; при FAIL определён создавший процесс, где это наблюдаемо |
| SAT-01 | Owner login/logout/session expiry/CSRF, navigation/refresh/Back | Корректное состояние UI, отсутствие доступа после logout и side effects при unauthorized запросе |
| SAT-02 | File picker/drag-and-drop upload, несколько файлов, одинаковое имя, retry/cancel/resume | Authoritative progress/state, checksum до success, collision policy без потери старой версии, нет дублирования после retry |
| SAT-03 | Download полного файла, Range/resume, HEAD, неверный/множественный Range, обрыв скачивания | Точный SHA/bytes/206/ETag; неверный Range без чтения лишних данных; pool освобождается при cancel |
| SAT-04 | Создать папку; rename/copy/cut/paste/move, mixed selection, защищённые roots | Корректная topology/IDs/содержимое; copy делает только явно заказанную копию; move не теряет данные; protected roots защищены |
| SAT-05 | Корзина: delete, restore, collision при restore, purge собственного тестового дерева | Обратимость до purge; корректные версии/сроки; permanent delete только выбранных fixture данных; shared ссылкам корректный отказ |
| SAT-06 | История/версии/preview и доступные операции восстановления версии | Download нужной версии точен; текущая версия/история соответствуют действию; preview не меняет bytes |
| SHARE-01 | Создать file/folder share, открыть отдельным guest context; browse/individual download/download-all | Только разрешённые действия; потомки ограничены shared root; ZIP list/SHA/count точны; owner credentials не нужны гостю |
| SHARE-02 | Password gate: неверный/верный пароль; session expiry; token expiry/revoke/max-downloads | Нейтральный отказ там, где нужен; пароль/token не в logs/storage; download-session учитывается ровно один раз |
| SHARE-03 | Share при rename/move исходника, затем trash/revoke; конкурентный guest read | Стабильные resource IDs; новые запрещённые чтения блокируются; уже начатый stream оценивается по текущему контракту, без придумывания нового |
| SHARE-04 | Попытка получить соседний ресурс/выход за shared root, прочитать чужую share session | Ноль forbidden bytes/side effects; корректная изоляция |
| DROP-01 | Owner/in-house Drop; public code redeem, неверный code, новый code/revoke | Правильная identity/expiry; public session только upload scope, без owner/storage listing |
| DROP-02 | Несколько файлов/клиентов/вкладок, drag/drop, refresh/SSE reconnect, разные channels | Каналы не смешиваются; очередь/status восстанавливаются; нет лишних reservations/uploads |
| DROP-03 | Upload→BUFFERED→TRANSFERRING→VERIFYING→STORED; cancel/retry, restart API/worker | STORED только после SHA и commit; buffered bytes сохранены при отказе backend; после restore одна публикация |
| DROP-04 | Expiry во время передачи, max files/bytes, заполненный buffer/недоступный storage | Новая admission запрещена по контракту; начатая имеет корректную continuation lease; отказ не удаляет pending bytes |
| WIN-01 | Новый Windows клиент: startup, UI lists/activity/settings, manual/background sync, close/reopen | Верный профиль/статусы, UI отвечает, transient background errors не создают блокирующих MessageBox |
| WIN-02 | Portable/MSI из одного payload; update/restart/rollback и несовместимое состояние на собственных profiles | Hash/версия/payload идентичны; profile/pause/credentials/originals сохранены; unsafe rollback отказан; старый payload доступен для восстановления |
| WIN-03 | Local permission/locked file/long path/reparse/hardlink/source replacement | Per-file defer или явный отказ без false ACK/unsafe cleanup; остальные файлы продолжаются |
| PLU-01 | Настройка daemon/CLI/TUI, source selection, pause/status/manual run/restart | Обычные entrypoints используют новый engine, сохраняют настройки и показывают реальный progress/errors |
| PLU-02 | Backup versions1…10…11, source deletion, файл256MiB−1/256MiB/256MiB+1 | Backup semantics и retention10; oversized refusal без потери прежних copies; предел не повышается ради PASS |
| PLU-03 | Изменение политики/source set, offline adoption, старый reader | Copies retained; scope change явен; originals не переписываются; несовместимый reader отказан |
| RES-01 | Network close/stall/slow progress/429/Retry-After/407/TLS failure через2hop | Deadlines/progress соответствуют policy; no generic mutation replay; pending recovery прежней identity |
| RES-02 | Direct/DNS/proxy P1→P2, недопустимый адрес, restore без FS event | Approved origin/allowlist/TLS сохранены, mandatory proxy без direct fallback, очереди возобновляются |
| RES-03 | Crash/restart exact owned client/API/worker/storage после зафиксированного checkpoint | Durable state восстанавливается; нет UNKNOWN→success по предположению и второго эффекта |
| RES-04 | Admission saturation, медленный consumer/storage, disk/spool/DB pressure | Backpressure/отказ по пределу; workers/connections/RAM bounded; после снятия давления работа продолжается |
| RES-05 | Совместные SYNC+upload+drop+share-download при отказе backend | Нет starvation control/UI; bytes/receipts/versions/shared policy согласованы; независимые операции не теряются |
| RES-06 | Возврат к фиксированному малому контрольному набору после каждой ступени | Нет накопления handles/connections/tasks/очередей; latency и RSS сравнимы с baseline с учётом зарегистрированных pending |

Дополнительные реализованные пользовательские функции включаются после инвентаризации, до admission соответствующего цикла. После6h расширять последний цикл новыми функциями нельзя.

## 6. Нарастающая нагрузка и достижение пределов

Нарастают **и объём, и разнообразие**. Нагрузка не увеличивается поверх необъяснённого нарушения целостности. На каждой ступени сначала новый сценарий на небольшом наборе, затем его масштабирование и сочетание с уже зелёными сценариями.

| Ступень | Ориентир корпуса/давления | Новая сложность |
|---|---|---|
| L0 |128файлов,≈128MiB,1активный пользователь | Обычные end-to-end цепочки и manifest/readback |
| L1 |2kфайлов,до1GiB,4пользователя | Параллельные клиенты, browser sessions, tiny/large mix |
| L2 |20kфайлов,до4GiB,16источников запросов | Burst/atomic saves, deep trees, move/rename, guest sharing/drop |
| L3 |100kфайлов,до12GiB суммарных live данных при наличии бюджета | Частые изменения, slow backend/consumer, ACK loss/restart, mixed workloads |
| L4 |До500kфайлов и максимальный безопасный корпус, до64источников запросов | Комбинации отказов, saturated queues/pools, boundary values и drain/recovery |
| L5 |Около измеренного предела конкретного bottleneck | Узкая ступенчатая нагрузка вокруг throughput knee/admission cap; фиксированный контрольный набор после разгрузки |

Это целевые ступени, не обязательство выделить отсутствующую память/диск. Значения повышаются по метрикам; число генераторов запросов не равно разрешённому числу product workers. Фиксируются reached limit, ресурс, accepted/rejected throughput, queue age, recovery и причина недостижения следующей ступени. Максимум нагрузки не имеет приоритета над проверкой результата.

- ПК:16logicalCPU/64GiBRAM; текущий Docker Desktop видит16CPU/~31.3GiBRAM. Движок не перезапускается ради увеличения памяти.
- Прежние тестовые caps4.5CPU/8MiB/s/affinity15 больше не потолок кампании. Начало умеренное; верхний суммарный бюджет ориентировочно14logicalCPU и до28GiB Docker RAM, с учётом Windows-клиента и наблюдаемой доступной памяти. Нельзя просто назначить каждому параллельному lane весь бюджет.
- Reserve: host free disk≥10GiB, host available RAM≥8GiB, дополнительный запас внутри Linux/Docker. При нарушении — остановка новой admission и drain; никогда не удалять unresolved originals ради освобождения места.
- Квоты включают source+spool+server copies+versions+SQLite/WAL+snapshot+backup+logs; стоимость копий нельзя забывать. Для большого retained корпуса предпочтительны освобождённые Docker volumes, а не новое дублирование на C:.
- Docker очистка освободила пространство **внутри VHDX**. Свободное место C: сразу после очистки осталось≈25.66GiB; файл docker_data.vhdx≈47.4GiB автоматически не уменьшился. Offline compaction запрещена условием о работающем движке. Использовать внутреннюю свободную ёмкость и мониторить оба уровня отдельно.
- Boundary tests: лимит−1/лимит/лимит+1 для product file size, chunk/frame, share package count/bytes, Drop reservations, queues и concurrent sessions. Малые override-квоты допустимы только в явно отмеченной quota fixture; они не доказывают достижение полного product maximum.
- Pluto256MiB/10versions, negotiated Neptune limits и hard worker/security caps не повышаются. Automatic batching остаётся OFF до отдельного benefit PASS; feature-specific testing не объявляется автоматическим включением.

## 7. Приёмка, доказательства и журнал

- Перед каждым циклом: source/binary/config/schema hashes, dataset seed+manifest, набор разрешённых действий, expected file/path/version/receipt outcomes, нагрузка и stop conditions.
- После каждой операции/цикла: client и authoritative server state; download/readback SHA всех изменённых объектов, count/names/versions/receipts; неизменный корпус проверяется по manifest и ротационному readback, с полной итоговой проверкой доступного retained набора. Sampling нельзя обозначать как полный readback.
- Для DUP сохраняются разрешённые локальные mutations и все неожиданные новые/переименованные файлы. Имена `(2)` сами по себе не доказательство дефекта; проверяются происхождение и expected manifest. Существующие пользовательские файлы не удаляются как «дубли».
- Resource series: throughput/p50/p95/p99, edit→publish, first publish, no-change, queue age, retries, CPU/RSS/handles/connections, bytes captured/sent/received/confirmed, disk+WAL+spool. Byte receive не равен publish.
- Доступные секреты — canary scan logs/errors/diagnostics; raw credentials остаются только в защищённых fixture configs.
- Журнал `.history/` обновляется при старте/конце цикла, FAIL, диагнозе, правке, повторе, смене нагрузки; во время долгой операции — heartbeat/progress запись не реже5минут. Краткие сообщения оператору во время активной работы — регулярно и при значимых событиях.
- Формат события: **дата/время сTZ → причина → до/входной гейт → что/как сделано → выходной гейт и результаты**. В журнале ссылки на primary evidence, не многомегабайтные дампы.
- FAIL не стирается новым пустым profile. Повтор использует тот же seed/inputs и retained state, где сценарий требует recovery; новая чистая fixture допустима только как отдельно названный repro, не замена доказательства.
- Итог раздельный: синхронизация A/B/C; network recovery; Saturn пользовательские функции; Windows/Pluto lifecycle; достигнутые лимиты. Отдельно unresolved/blocked/not-run и прежний C01 historical-prefix blocker.

## 8. Подготовленные материалы и стартовый гейт

- Журнал подготовки: [2026-10-15-six-hour-preparation.md](C:/.projects/exocortex/.history/2026-10-15-six-hour-preparation.md).
- Inventory/очистка/сборки: `.audit/2026-10-15/run-preparation/`.
- [Отчёт подготовки](C:/.projects/exocortex/.audit/2026-10-15/run-preparation/PREPARATION_REPORT.md), `preparation-manifest.json` и `coverage-ledger.json` в том же каталоге фиксируют подготовленные материалы и ещё не выполненные сценарии.
- [Политика времени и параллельных циклов](C:/.projects/exocortex/saturn/scripts/endurance/campaign-policy.mjs) и её [адресные проверки](C:/.projects/exocortex/saturn/scripts/endurance/campaign-policy.test.mjs): 11/11 PASS. Проверены граница 6 часов, продолжение последнего цикла, repair/retest, resume без нового окна и отказ принимать запоздалый результат прежней попытки. Модуль не запускает процессы; его подключение к dispatcher/watchdog и проверка этого подключения обязательны до T0.
- Windows MSI/ZIP собраны из одного локального self-contained payload 0.1.18-dev; упаковка использует отдельный тестовый trust key. Это материалы изолированного стенда, не официальный подписанный релиз и не основание менять production trust. Старый клиент пока не заменён.
- Предыдущие квалифицированные адресные результаты: `.audit/2026-10-14/completion-213745-40d741a8/REPORT.md`.
- Existing dataset/readback/native lifecycle/controller инструменты сохранены в `.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/endurance-6h/`; их старые source hashes, caps и команды не подходят автоматически к новому запуску.
- До T0: новые frozen cohort/hash; empty/new owned compose resources; явный local endpoint allowlist; private fixture identities; Windows isolated profile/backup path; actual browser и client entrypoints; короткий dispatcher/watchdog/resume/no-admission-after6h self-check; source/remote readback smoke; проверка, что исходный default vault не входит в workload.
- Подготовка или успешный build не означают PASS пользовательских сценариев. Пока нет явного следующего «запускай», не создавать T0, heartbeat automation, нагрузочный процесс или автозапуск кампании.
