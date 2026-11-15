# Сетевое восстановление: остаточные доработки и целевая приёмка

Дата: 2026-10-14. Команда исполнителю: **«Работай по сетевому плану NETWORK_REVIEW_AND_TARGETED_TEST_PLAN_2026-10-14.md»**. Прочитать выводы, реализовать подтверждённые остаточные доработки в своей области, добавить и выполнить перечисленные тесты: **тест → FAIL → адресное исправление → повтор затронутого сценария**. При подготовке этого документа выполнялось только чтение; новых тестовых результатов нет.

Временного бюджета и оценок длительности нет. Числа deadline/Retry-After ниже — проверяемые свойства протокола, а не срок работы агента. Полный pipeline и шестичасовой прогон не запускать. Рабочую сеть, пользовательский Obsidian/profile, установленный клиент и production Saturn не изменять для экспериментов; использовать собственные TCP/proxy fixtures и disposable VM.

## 1. Что уже сделано и что пока не доказано

Прочитан [журнал сетевой реализации](C:/.projects/exocortex/.history/2026-10-14-network-resilience-implementation.md) и соответствующие исходники Neptune/Pluto/Nginx. Реализованы: Neptune lifetime полного HTTP response body, idle timeout передачи, coordinator поколений маршрута, OS network/resume hints и автоматический probe; retained legacy originals; Pluto proxy policy, разрешённые DNS candidates и CONNECT, отдельный heartbeat worker; Nginx `/sync/v1/` и запрет upstream replay.

По журналу ранее прошли выбранные Neptune наборы 52 и 32 tests, Pluto18 верхнеуровневых checks и Nginx template9 tests. Это **отдельные журнальные запуски с возможным пересечением наборов**, не сумма уникального покрытия и не новая проверка. Go использовал compile overlay, Windows build — временную замену alias-файла, часть .NET runs — suppression CA1416 и временный Include startup partial. Два engine tests остались FAIL. Реальная Wi-Fi/VPN/sleep-resume и live Nginx proxy chain не квалифицированы.

**Вывод:** фундамент восстановления реализован, но полной приёмки нет. Ниже есть подтверждённые по исходникам пробелы; сначала закрыть их и compile integration, затем подтвердить поведение на текущем дереве без overlays.

## 2. Конкретные доработки

### NET-R1 — успешное восстановление доступа должно разблокировать именно проверенную очередь Neptune

**Доказательство:** [SyncRetryController.cs](C:/.projects/exocortex/neptune/src/Neptune.Core/SyncRetryController.cs) классифицирует 401/403/407 и TLS как `AUTH_REQUIRED`; [NeptuneStateStore.OperationSchedule.cs](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.OperationSchedule.cs) пишет `not_before=long.MaxValue`. `ResumeClientAuthorizationAsync` вызывается только offline profile `resume`. [WindowsSyncService.cs](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsSyncService.cs) при успешном probe пересоздаёт sessions и сообщает WorkAvailable, но не снимает эти durable ожидания. Следовательно, успешный heartbeat после исправления proxy/TLS сам по себе не обеспечивает продолжение original операций.

**Изменить:** добавить bounded, scope-specific восстановление authorization wait после повторной проверки именно исходного root/device/binding/namespace/qualification и доступа к original status. Выполнять после drain старого owner, до допуска новых sends, в корректной owner transaction. Не использовать глобальный сброс всех schedules/attempts и не удалять originals. Связать release с актуальным route generation; старая probe completion не авторизует новый маршрут. Если heartbeat успешен, а root/original endpoint по-прежнему 403, блокировку сохранить с точным UI state. TLS validation не ослаблять. Offline resume сохранить как явный operational path.

**Приёмка:** N04, N05, N07. После восстановления действительного доступа pending original завершается без перезапуска/нового file event, с прежним ID. Недоступные scopes остаются заблокированы.

### NET-R2 — probe ошибки должны сохранять новый Retry-After и точную причину

**Доказательство:** [NetworkRecoveryCoordinator.cs](C:/.projects/exocortex/neptune/src/Neptune.Core/NetworkRecoveryCoordinator.cs) в catch probe exception не анализирует ошибку, ждёт фиксированный `_retry`. `_notBefore` задаётся только внешним Invalidate. `WindowsSyncService.SendHeartbeatAsync` вызывает `EnsureSuccessStatusCode`, теряя response Retry-After. Probe503→Retry-After или 407 после первоначального DNS failure не обновляют соответствующим образом срок/State.

**Изменить:** передать из heartbeat typed status/retry metadata с delta-seconds и HTTP-date, bounded response-body handling. Coordinator на failed probe обновляет failure class и lower-bound not-before, сохраняя исходное enrollment. Success/late result применять только к текущему generation. OS event storm не отменяет server lower bound. Не добавлять автоматический повтор произвольных HTTP mutations в policy.

**Приёмка:** N03/N04/N06. Новый Retry-After от самого probe выдерживается; 407 отображается как proxy authorization, а не старый DNS state. User cancel остаётся отдельным исходом.

### NET-R3 — Pluto data transport: idle deadline вместо фиксированного срока всей передачи

**Доказательство:** [guarded_http.go](C:/.projects/exocortex/pluto/internal/pluto/syncstate/guarded_http.go) создаёт `http.Client{Timeout:45*time.Second}` для control и data; small-batch использует этот client. Прогрессирующая 4MiB chunk или 32MiB batch на медленном/многошаговом маршруте может прерваться по общему сроку. Legacy [client.go](C:/.projects/exocortex/pluto/internal/pluto/client.go) имеет общий 5min timeout; не следует выдавать его за idle policy.

**Изменить:** разделить control/long-poll и data request lifetime. Для guarded metadata сохранить полный bounded deadline45s, long-poll45s при серверном ожидании≤25s, connect/TLS10s; для chunk/batch data применять idle30s с продлением на фактическом чтении/записи bytes и caller cancellation, без фиксированного whole-transfer45s. Не считать enqueue/progress callback передачей байтов. Для legacy оставить обоснованный запас ожидания server copy headers (сейчас 2min), но явно разделить его с body idle и длительностью data upload: не укорачивать server-side copy до 30s без проверки контракта. Admission wait тоже bounded/cancellable, request-body wrappers не копируют whole payload дополнительно. Cleanup освобождает slot/connection после всех исходов.

**Приёмка:** N01/N02/N08/N09. Медленный поток с реальным прогрессом живёт дольше control budget; зависший поток завершается по idle и сохраняет original. Отдельно подтвердить default policy values и тесты с уменьшенными injected durations, чтобы не тратить минуты на каждый негативный вариант.

### NET-R4 — не маскировать обрыв тела Pluto под format/limit error

**Доказательство:** `Remote.request` в [client.go](C:/.projects/exocortex/pluto/internal/pluto/client.go) объединяет `io.ReadAll` error и `len(raw)>65536` в `errors.New("remote response exceeds limit")`. Теряется EOF/reset/context причина; `networkWaitState` не распознаёт такой error как сетевой. В guarded path тело разбирается до status-specific failure: требуется проверить 401/403/407/429/503 с неполным/не-JSON телом, чтобы не терять доступ/Retry-After.

**Изменить:** отдельно возвращать caller cancellation, transport body failure с preserved cause и actual overflow/protocol failure. Сохранить status/Retry-After до чтения тела, читать error body bounded; transport loss не означает безопасный replay. Проверить тот же порядок в `small_batch_http.go` и Neptune guarded response parsing; править только воспроизводимый аналогичный дефект, не менять wire validation на permissive. Authorization body HTML не разрешает менять token/root.

**Приёмка:** N02/N06/N09/N10: обрыв после headers классифицируется как connectivity, oversize валидного тела — limit, malformed complete JSON — protocol. 407/Retry-After не исчезают из-за HTML/empty body.

### NET-R5 — compile gates и known-red integration, владельцы

Исправить в реальном дереве, без временной подстановки:

| Gate | Подтверждённое состояние | Кто исправляет / что проверить |
|---|---|---|
| G-B1 | Test csproj линкует `WindowsUpdateTransaction.cs`, но не `WindowsUpdateTransaction.Startup.cs`. | CHAT-B/B00 добавляет partial Compile link; network ждёт его готового source hash. |
| G-B2 | `MainWindow.MappingReview.cs` содержит локальный MessageBox alias, уже определённый global в `GlobalUsings.cs`. | CHAT-B/B00 убирает дублирование и проверяет обычную Windows build. |
| G-B3 | Сетевой журнал сообщает CA1416 в linked `WindowsProfileCommands.cs`. | CHAT-B/B00 исправляет platform contract/guard и пересобирает без NoWarn. По одному чтению не объявлять предупреждение воспроизведённым заново. |
| G-C1 | `daemon_http.go` передаёт `m["binding"]` типа any в `ReadBinding(map[string]any)`. | CHAT-C/C00 добавляет строгую type check и negative tests, без permissive parser. |
| G-B4 | `ActualLostPrepareReplyReusesServerOperationInsteadOfCreatingAnother` и `ActualNewWriteAfterFirstPublishCannotBeClearedByOlderGenerationAck` FAIL по журналу; deadline scheduling не учтён. | CHAT-B/B11 воспроизводит, задаёт due через controllable clock, проверяет тот же original и dirty g+1. Network затем запускает только эти 2 affected integration cases на итоговом дереве. Не удалять assertions ради зелёного статуса. |

Если A/B/C сейчас не выполняются, исполнитель сетевого задания может закрыть эти минимальные blockers сам с записью владения в журнале. При одновременной работе единственный writer файлов — назначенный B/C, сетевой чат продолжает независимые lanes. Новые чаты не создавать и сообщения другим чатам без указания оператора не отправлять.

### NET-R6 — proxy переключение и эксплуатационная граница

Pluto уже поддерживает `environment/direct/explicit` и защищённый config; новый config применяется при открытии service/session. Live proxy editor/reload не реализован и не является доказанной ошибкой текущего dial. Neptune пересоздаёт clients после route fault. **Не заявлять автоматическое обнаружение любой системной proxy-настройки без N12.**

Для восстановления текущего маршрута проверить неизменный approved origin/allowlist при смене DNS/interface/proxy reachability. Добавление нового explicit proxy в конфиг требует явного apply/reopen; если N12 показывает, что существующий apply оставляет старые transports, добавить атомарный путь: validate config → pause new admission → cancel/drain old generation → construct transports → qualified probe → resume same originals. Не пытаться менять environment чужого работающего процесса и не обещать, что Linux daemon автоматически читает Windows system proxy. Environment mode квалифицировать в новом процессе с заданным env. Direct fallback при обязательном proxy запрещён.

## 3. Общие условия тестирования

Журнал: `C:/.projects/exocortex/.history/2026-10-14-network-targeted-validation.md`; при существовании продолжить. Evidence: `.audit/2026-10-14/network-targeted-validation/<run-id>/<N-ID>/`. Для каждой записи: **дата/время+offset; причина; до/входной гейт; что/как сделано; выходной гейт/точная команда/tests/pass/fail/skip/artifacts**. Отдельно фиксировать начало, результат, исправление, повтор и конечный source hash.

Fixtures:

- Loopback TCP server с управляемыми barriers на accept, headers, каждый body chunk, durable commit, response ACK. Fault relay может close/reset/drop только свой connection. После restart использовать ту же disposable SQLite DB и server operation store. Нужны actual socket/body failures, не только exception из mock.
- Пакеты: small metadata,1KiB file,12MiB+17 stream, mixed6-item batch (2published/2missing/1partial/1rejected),32MiB batch + до 4MiBmetadata для ingress. Независимый SHA исходных и опубликованных bytes; original manifest с IDs/intent/expected/offsets/hash до fault.
- Test auth root A/B, token-A, proxy credentials отличны от origin credentials. TLS fixture CA локальна тесту; production certificate validation не отключать. Снимать trace адреса/метода/operation key/status/bytes и только факт наличия credentials, не значения.
- Backoff/clock injectable. Тестовые control/idle budgets можно уменьшить, сохраняя ratios; отдельно assert production defaults. Для реального socket timeout разрешить узкую platform scheduling tolerance, записанную до запуска; не повышать её задним числом для зелёного результата. Ни одного бесконечного retry в harness.
- Proxy/env изменять в child process, не process-global env одновременно с другими tests. Все child helpers запускаются скрыто на Windows, с отдельными logs/PIDs; stop только своих helpers.
- SKIP/overlay/missing toolchain/fixture/нулевой filter match — не PASS. Если native VM отсутствует, N16 остаётся NOT RUN/BLOCKED; автономные socket/SQL cases продолжить.

## 4. Наборы, команды и параллельные lanes

**Lane N-dotnet:** Neptune deadlines/coordinator/retained originals. **Lane N-go:** Pluto proxy/body/progress/heartbeat/originals. **Lane N-ingress:** шаблон и live2-hop Nginx. Они могут выполняться одновременно с отдельными endpoints/state. Сборка и правка одного проекта serial. Native N16 и performance/progress metrics выполнять отдельно от нагружающих lanes; N12 process-env tests не параллелить внутри одного процесса. Дополнительные агенты не обязательны: lanes можно запускать обычными независимыми test processes.

При общей работе с CHAT-B выполнять правила shared `bin/obj` из [плана A/B/C](C:/.projects/exocortex/saturn/docs/implementation/TARGETED_TEST_PLAN_CHAT_A_B_C_2026-10-14.md): OS file lock `.audit/2026-10-14/targeted-tests/locks/neptune-build-run.lock` на весь build/test batch или отдельная source copy с актуальными uncommitted файлами и isolated outputs. Не запускать пересборку поверх чужого тестового процесса. Отсутствие lock-owner после завершения процесса определяется OS lease, не удалением чужого marker. Это не мешает параллельным Go/ingress lanes.

Из Neptune после G-B1–G-B3:

```powershell
& C:/Users/pc/.dotnet/dotnet.exe build tests/Neptune.Core.Tests/Neptune.Core.Tests.csproj
& C:/Users/pc/.dotnet/dotnet.exe build src/Neptune.Windows/Neptune.Windows.csproj
& C:/Users/pc/.dotnet/dotnet.exe test tests/Neptune.Core.Tests/Neptune.Core.Tests.csproj --no-build --no-restore --filter 'FullyQualifiedName~NetworkDeadlineTests|FullyQualifiedName~NetworkRecoveryTests|FullyQualifiedName~RetainedLegacyUploadTests|FullyQualifiedName~NetworkAcceptanceTests' --results-directory <свой-absolute-evidence-dir> --logger trx
```

`NetworkAcceptanceTests.cs` — **новый** файл, методы `N01_`… по таблице; существующие сценарии расширять/переиспользовать, не дублировать assertions без необходимости. Для точечного повтора точный class/method. Включить прежние `HeadersWithoutBodyReleaseGuardedOriginSlots`, `ProgressingTransferOutlivesControlBudget`, `StalledUploadTimesOutWithoutReplay`, `CallerCancellationRemainsCancellation`. Набор `TransferSafetyTests` целиком не обязателен: только методы, чей retained-upload путь изменился после фикса.

Из Pluto в Linux/WSL после G-C1:

```bash
go test ./internal/network -run '^Test(ProxyModesShareEnvironmentAndExplicitPolicy|InvalidProxyPolicyFailsClosed|NetworkAcceptance)' -count=1 -json
go test ./internal/pluto/syncstate -run '^Test(GuardedDNSFallback|GuardedProxy|IsolatedTransport|NetworkAcceptance|GuardedHTTPLostPublicationAndAppendRecoverOriginalIdentity|HTTPBindingLostPreparePersistenceAndCompleteRestart|SmallBatchDispatchLostPrepareAndDataRestartSubset|HTTPFolderLostAckOriginalAndConflictHistory)' -count=1 -json
go test ./internal/pluto -run '^Test(Heartbeat|NetworkAcceptance)' -count=1 -json
```

Новые методы `TestNetworkAcceptanceNxx...` поместить в соответствующий package: network — config; syncstate — guarded HTTP; pluto — Remote/Service/heartbeat. Два существующих proxy-policy test names сверены с `proxy_test.go` и включены явно. Проверять число выбранных тестов и все ожидаемые имена; zero match запрещён. Отдельный `-race` только для новых concurrent heartbeat/transport admission cases после обычного PASS, не `./...`.

Из Saturn:

```powershell
node --test infra/production/nginx-ingress.test.mjs
node --test infra/production/network-chain.integration.test.mjs
```

Второй файл — новый harness N14/N15, поднимающий **собственную** 2-hop chain из текущего template и контролируемый upstream. Он должен fail при отсутствии fixture manifest, а не silently skip. Никаких `prod:*`, live config reload или release deploy. Для применения шаблона создать disposable config с собственными upstream/ports/certs. В repo есть Nginx template, но отдельный pinned Nginx image в просмотренных Compose не найден: использовать доступную стендовую установку/образ Nginx, предварительно записав точную версию и digest в fixture manifest; оба hop используют один pin. Не подменять production endpoints.

## 5. Точные сценарии и критерии

Все подварианты строки обязательны для указанных клиентов. Где требуется fault после commit, сервер fixture сначала сохраняет receipt, затем relay рвёт ответ. Проверять **не только отсутствие exception**, но и durable очередь/оригинал/remote effect.

| ID / владелец lane | Arrange → действие / fault | Проверяемый результат |
|---|---|---|
| **N01 / .NET + Go — deadlines/progress** | Control: headers200 пришли, body никогда не заканчивается. Data: передавать блоки с gap<idle так, чтобы total>control budget; затем один gap>idle. Long-poll сервер ждёт 25s в production config (в unit — масштабированный equivalent). | Control завершается по полному deadline, слот освобождён. Data с прогрессом проходит и SHA верный; stalled data прерывается по idle, original остаётся. Long-poll не убит idle30 до server≤25 и имеет полный deadline45. После timeout valid request проходит через тот же pool. По Go отдельно проверить больше 45s equivalent для chunk/batch и отсутствие whole-transfer timer. |
| **N02 / .NET + Go — cancellation/body** | Оборвать TCP после headers, посередине JSON и в gzip trailer; complete invalid JSON, oversized body отдельно. Cancel caller во время admission/send/read; cancel после physical commit до ACK. | Reset/EOF/idle классифицированы connectivity, полный malformed/oversize — protocol/limit. User cancellation остаётся cancel без misleading network-failure UI. Pending original не deleted/ACKed, no generic mutation replay. Drain освобождает connection/read/admission slots; next request не висит. |
| **N03 / .NET — generations/storm** |100 NetworkAddress/Availability signals, probe удержан barrier; новый route event во время probe; отключение→подключение без file events; dispose/service close во время failed probe. | Старый token cancelled, новый send до successful current-generation probe запрещён; concurrent probes≤1. Stale success не открывает admission. После подтверждённого recovery один wake, originals продолжаются; shutdown joins worker, больше callbacks/requests нет. |
| **N04 / .NET — actual service recovery** | Реальный WindowsSyncService +state fixture: transport reset в prepare/chunk/complete по 3 вариантам; recreate client sessions через probe. Source после fault изменён/удалён, g+1 уже dirty. Затем сеть здорова без новых FS hints. | Recovery status-first same ID/input, только missing/remaining data; publication count=1, old bytes/hash соответствуют original. Current g+1 не cleared old ACK. Old sessions drained, new session reopening не теряет schedule. Успешный probe сам приводит к progress, а не только UI Online. |
| **N05 / .NET — AUTH_REQUIRED release (NET-R1)** | ScopeA original получает 407, потом proxy credentials исправлены и root status доступен; отдельно TLS invalid→valid и transient401. ScopeB heartbeat200, но own original endpoint403. Restart при AUTH_REQUIRED. | A автоматически выходит из `long.MaxValue` после qualified current-generation check, без reset профиля и нового file event; same operation завершён. B остаётся blocked с точной причиной, token/queue сохранены. Нельзя глобально resume all scopes по одному heartbeat. Persisted AUTH после restart проверяется тем же путём. |
| **N06 / .NET + Go — Retry-After/status** |429/503 от mutation, затем probe503 с более поздним Retry-After; delta seconds и HTTP-date, invalid/expired values,407/401/403 с HTML/empty body,409 CAS,400 invalid input. OS event и new dirty hint до not-before. | До max(valid persisted/server not-before) нет повторного probe/send. Probe error обновляет State. Invalid/expired header не создаёт negative wait/overflow. 407≠401/403≠DNS/TLS; CAS/400 не становятся network-retry loop. Credentials/IDs сохранены; reset/restart не обходит deadline. Для истинного 401/403 автоматический доступ не предполагается. |
| **N07 / .NET — retained legacy originals** | Prepare/append/complete ACK loss × source unchanged/changed/deleted; новый process/store. Server upgraded to guarded при pending legacy; resumable endpoint пропал; quota8GiB/512 originals на fixture counters, corrupted/missing spool; CAS remote edit. | Sealed bytes/hash/expected/offset/original key сохраняются. Recovery legacy происходит до новой guarded negotiation/writes. Endpoint disappearance не разрешает downgrade повтором PUT. Quota/corrupt spool блокируют новое admission с сохранением evidence; no cleanup pending. CAS conflict не overwrite. Не заявлять guarded history guarantees для legacy DAV. |
| **N08 / Go — DNS/CONNECT/TLS** | DNS: первый IPv6 отказ, второй IPv4 разрешён; первый запрещён allowlist, второй разрешён; все запрещены. CONNECT на pinned allowed IP, origin SNI hostname. HTTP и HTTPS proxy; invalid origin cert иinvalid proxy cert; proxy407 и CONNECT timeout; partial/oversized CONNECT headers>32KiB. | Перебираются только allowed candidates в общем connect10s; общий budget не умножается на их число. CONNECT не отдаёт proxy право заново выбрать origin IP. TLS проверяет оба соответствующих hostname. Origin Authorization не уходит proxy, Proxy-Authorization не уходит origin. Никакого direct fallback при mandatory proxy, headers bounded, error releases sockets. |
| **N09 / Go — guarded/batch originals** | Lost prepare/append/complete/publication ACK; new store/session; chunk ACK map, mixed6-item batch; fault при progress иbody error. Удалить local source после accepted original. | Existing four original-recovery tests PASS на actual tree. Same IDs и canonical originals, one effect; accepted chunks/items не resend, subset только missing. Неопределённый status сохраняет queue/UNKNOWN, не новая операция. Read failure не маскируется contract error и не теряет original. |
| **N10 / Go — legacy Remote body/errors** | Remote JSON response: headers200→partial body→reset; context deadline; body65536/65537; complete malformed JSON. Heartbeat error responses401/403/407/503 с Retry-After. Legacy copy server delay headers в рамках существующего 2min contract (масштабировано). | NET-R4: network cause доступна classifier, limit отдельно, malformed отдельно. Caller cancel не reconnect storm. Token/root остаются, heartbeat lower-bound соблюдён. Legit queued copy не отсекается новым слишком коротким control timeout. |
| **N11 / Go — heartbeat/control loop** | Worker получает 100 updates, first request hangs; latest status меняется; pause/status/stop во время ожидания; old-token reply после reenrollment; recover after network without file event. Legacy copy scheduler получает network failure при других pending jobs. | Heartbeat active≤1, pending status≤1/latest, deadline10s; loop/status/pause отзывчивы, shutdown joins. Stale origin/token reply ничего не меняет. После recovery queued original продолжается. Новый legacy copy admission прекращается при network failure, уже confirmed результаты сохранены. |
| **N12 / .NET + Go — route/proxy change** | Child processes: direct route здоров→недоступен→здоров; proxy endpoint P1→P2 через explicit validated apply/reopen; environment child с HTTPS_PROXY/NO_PROXY; approved DNS address поменялся, disallowed address; Neptune recreated client после system proxy change в VM. | Переход не сбрасывает profile/binding/original IDs. Старые route requests drained/cancelled, correct new route использован. Mandatory proxy failure не вызывает direct egress. NO_PROXY/direct только по явной policy. Неутверждённый адрес запрещён. Если live apply отсутствует, точно документировать required reopen и не считать native auto-recovery доказанным. |
| **N13 / .NET + Go — resources/secrets** |Повторить последовательно 12 циклов fault→recover на каждом изменённом request path; отдельно saturation8 Neptune origin slots /4 Pluto connections, cancellation waiters; proxy secret иtoken canary. | После каждого цикла active/leased/admission возвращаются к baseline; max concurrency не превышен, 9-й/5-й waiter после освобождения проходит. Нет роста retained tasks/channels вне сохранённых pending originals. Canary отсутствует в diagnostics/errors/logs, headers credentials не перепутаны. Это ограниченная leak regression, не endurance. |
| **N14 / ingress — exact routing/limits** | Template9 tests затем реальный Nginx: `/sync/v1/` GET/POST/chunk/multipart, `/api/v1/`, DAV; route path/query, Authorization, conditional headers, content encoding, offsets иresponse ETag/Retry-After. Near36MiB valid batch с framing иrequest>40MiB. Control error JSON401/403/409/429/503. | Guarded путь доходит до API без rewrite смысла. Valid request в 40MiB проходит ingress (API применяет точные 32+4MiB limits), >40MiB rejected до upstream effect. Ответы не заменены HTML, headers сохранены; no cache/buffering/upstream replay. DAV прежний размерный контракт сохранён. Template PASS не заменяет live observations. |
| **N15 / ingress + clients — two hops/end-to-end** | Chain client→proxy1→proxy2→fixture API, на каждой стороне trace. Для Neptune и Pluto lost response после durable commit; stall upload/body; close middle hop; long-poll; proxy407; Retry-After. Один stream, один batch, один control original. | Ни один hop не повторяет mutation автоматически; upstream effect count=1. Clients восстанавливают original status/offset/receipt после возвращения chain. Long-poll возвращает событие/нормальный timeout, не HTML gateway response. Повтор не меняет hash/IDs и g+1. Отсутствующий `/sync/v1/` на любом hop обнаруживается явным FAIL, не скрывается enrollment reset. |
| **N16 / native VM — Windows/Linux route/sleep** | Только disposable VM/adapter: активная передача→adapter down/up; другая сеть/interface; VPN/proxy tunnel enable/disable; sleep/resume Windows с pending original. Linux daemon restart после route change. После возврата сети не создавать новых файлов. | Реальные OS hints/transport failures приводят к automatic recovery и progress queue; та же identity/байты и один receipt. Background UI без blocking MessageBox, user cancel отдельный. Auth/TLS issue требует корректного доступа, не bypass. Pause/sync-disabled остаётся paused. Raw trace+state before/after; synthetic signals не подменяют native PASS. |

## 6. Минимальные повторные наборы и завершение

- NET-R1/R2 coordinator/schedule fix → N03–N06 и два G-B4 methods, плюс N04 original recovery. NET-R3 transport lifetime → N01/N02/N08/N09/N13 на затронутом Go path. NET-R4 error classification → N02/N06/N10 и affected N11. Nginx fix → N14 + affected N15. Proxy apply fix → N08/N12/N13. Не повторять все соседние системы после локального исправления.
- Тест с failed assertion сначала сохранить с raw trace/state; установить причину: product defect, fixture defect или несовместимое ожидание после durable retry. Исправление fixture не должно ослаблять original identity/CAS/generation assertions. Retry due моделировать, не обходить production schedule.
- После последнего изменения пересобрать только изменённые проекты, выполнить affected matrix на текущих исходниках без overlays, опубликовать таблицу N01–N16 со всеми подвариантами, команды, hashes, результаты, ограничения native стенда. Внести итог в журнал, передать конкретные незакрытые IDs.
- Готовность: NET-R1–R4 исправлены и доказаны; G-B/G-C integration проходит; обязательные targeted cases зелёные; no unexplained SKIP/FAIL, no credential loss, no duplicate effect, no permanent stuck queue после возврата корректного доступа. Если N16 не выполнен, явно указать «socket/HTTP/proxy fixtures приняты; native network transitions не квалифицированы» — не заявлять, что любые будущие сетевые условия уже гарантированно покрыты.
- Production proxy deployment, установка release binaries, работа с реальным vault и 6h остаются отдельными действиями оператора. Этот план не запускает их автоматически.
