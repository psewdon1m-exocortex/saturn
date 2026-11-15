# Доработки по замечаниям этапа 3

Дата: 2026-10-14, UTC+03:00. Основание: поручение оператора лично реализовать незакрытые пункты [приёмки A–C](C:/.projects/exocortex/saturn/docs/implementation/STAGE_3_IMPLEMENTATION_REVIEW_2026-10-14.md), без тестов.

**Результат по коду: R02–R05 реализованы, UNVALIDATED. По R01 внесена ограниченная оптимизация retained frontier; доказательство причины исторического 300-секундного отказа остаётся OPEN. Полную runtime-приёмку этот отчёт не объявляет.**

Изменены 15 файлов исходников/контрактов: 11 существующих и 4 новых. Новая миграция не применялась. Тесты, сборки, typecheck/lint, установка, runtime/native/crash experiments, контейнеры, deployment и шестичасовой прогон не запускались. Сетевые изменения параллельного чата не изменялись и здесь не оцениваются. Установленный релизный клиент не обновлялся.

## R01 / C01 — retained recovery

Файл: [NeptuneStateStore.ParentReconcile.cs](C:/.projects/exocortex/neptune/src/Neptune.Core/NeptuneStateStore.ParentReconcile.cs).

Ранее `SeedParentFrontier` открывал write transaction на каждые 40 unresolved records, даже если это data-only события, которым не нужен namespace lookup. Теперь он декодирует до 256 записей, но обрабатывает не более прежних 40 значимых событий за транзакцию. Durable `record_after` указывает только на последнюю фактически рассмотренную запись; нерассмотренный остаток берётся следующим вызовом.

Не меняются исходные payload, unresolved/disposition records, generations, originals, receipts, правило полного membership proof и отказ при известном inside hardlink. Пропуск незначимого для frontier события не превращает его в доказательство Outside и не удаляет его из журнала. Формат БД не меняется.

Это уменьшает число транзакций на data-only backlog. Связь этой стоимости с исходным отказом пока не доказана: сохранённые материалы показывают backlog и незаконченный membership plan, но не дают достаточного phase timing. Поэтому R01 не закрыт полностью. Сброс профиля, увеличение timeout и удаление inbox не выполнялись.

## R02 / C02–C07 — guarded Pluto retention 10

Реализация:

- [0067 up](C:/.projects/exocortex/saturn/packages/database/migrations/0067_guarded_pluto_retention.up.sql), [0067 down](C:/.projects/exocortex/saturn/packages/database/migrations/0067_guarded_pluto_retention.down.sql).
- [CatalogPlutoRetention](C:/.projects/exocortex/saturn/packages/file-core/src/catalog-pluto-retention.ts).
- [GuardedRuntime](C:/.projects/exocortex/saturn/packages/sync/src/guarded-runtime.ts), [manifest](C:/.projects/exocortex/saturn/packages/sync/src/guarded-runtime-manifest.ts).
- [worker composition](C:/.projects/exocortex/saturn/apps/worker/src/main.ts), [worker lifecycle](C:/.projects/exocortex/saturn/apps/worker/src/worker.ts).
- [DurableBackendExecutor](C:/.projects/exocortex/saturn/packages/storage/src/durable-backend-executor.ts).

Публикация версии атомарно ставит ресурс в durable maintenance queue. Уже существующая история ставится в очередь миграцией и последующей offline activation/adoption. Отдельный worker step вызывается раз в 2 секунды, не перекрывается сам с собой, использует maintenance barrier и advisory lock; при остановке worker он присоединяется к остальным active jobs.

Политика сохраняет текущую версию независимо от её timestamp и девять последних active historical versions. Дополнительно сохраняются pinned versions. Неразрешённые publication/namespace/stream originals консервативно откладывают retention root; для ещё не опубликованных batch originals проверяется exact expectedVersionId и terminal journal по operation_key. Laboratory pinning защищено row lock, поэтому новое закрепление не может выиграть гонку после expiry.

В одной SQL transaction создаются неизменный retention original и backend task, а выбранная историческая версия переводится в `expired`. **Это логический expiry, а не доказательство удаления bytes.** Физический delete идёт через существующего единственного backend writer, с проверкой private archive path, file type, size и SHA-256. Удаляется конкретный файл; рекурсивной очистки каталогов нет. На всём backend допускаются максимум две одновременно ожидающие/выполняемые retention-задачи, чтобы maintenance не заполнял writer FIFO.

После durable `DONE` создаётся retention receipt. Перезапуск до получения receipt продолжает тот же task ID. Повтор после `UNKNOWN`/fenced rejection разрешён только для этого exact expired-version original, после сохранённого reviewed handoff между поколениями и подтверждения закрытия старых соединений. Отсутствующий файл допустим как идемпотентный результат именно для такого original. Обычные неопределённые backend operations не переигрываются.

Старые upload/namespace receipts и `file_versions` rows сохраняются. Down migration отказывает, если retention originals уже появились. Authority rows защищены от произвольного DML и TRUNCATE. Diagnostics отдельно показывают pending resources, pending delete bytes и unknown deletes; они не приравниваются к освобождённому месту.

Ограничения: retention выполняется постепенно; pending originals и pins могут временно сохранять более десяти версий. Цена проверки SHA архивов и реальный срок освобождения места не измерены. Неопределённое физическое состояние без external fencing остаётся заблокированным.

### Подключение при будущем deployment

1. После отдельной проверки применить 0067 штатным migrator при остановленных writers; в этой работе этого не делалось.
2. В reviewed role plan назначить `public.sync_retention_command(uuid,jsonb)` владельцу writerOwner и дать EXECUTE writerLogin. Runtime получает только SELECT на `sync_retention_work`/`sync_retention_originals` для diagnostics; writerOwner — нужные DML права на эти таблицы, прежний backend queue/catalog и SELECT на pins/handoffs. Не давать runtime DML/TRUNCATE или EXECUTE новой SECURITY DEFINER функции.
3. Trigger helpers оставить invoker-функциями у migrator; не переносить их во writerOwner: role qualification разрешает у него только перечисленные SECURITY DEFINER entry points. Сохранить необходимые существующие права writerOwner на helpers `catalog_guard_scope`, `catalog_guard_active_valid`, `sync_backend_command` и чтение root/device/policy/journal/stream/batch/laboratory tables.
4. В v3 manifest добавить hash новой функции и заново получить qualification receipt для согласованного состава. Старые v3 manifests без функции новый parser отвергает. V1/V2 список entry points не менялся. Реальные grants, manifests и qualification receipts не подделывались и не обновлялись.

## R03 / C19 — незавершённые обновления Neptune

Файлы: [App.xaml.cs](C:/.projects/exocortex/neptune/src/Neptune.Windows/App.xaml.cs), [WindowsUpdateTransaction](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsUpdateTransaction.cs), [startup/recovery](C:/.projects/exocortex/neptune/src/Neptune.Windows/WindowsUpdateTransaction.Startup.cs), [UpdateApplyMode](C:/.projects/exocortex/neptune/src/Neptune.Windows/UpdateApplyMode.cs).

GUI и profile-command получают installation lease и проверяют update journal до writable действий. Lease живёт до завершения процесса; updater требует эксклюзивный lease и закрытые профили этой установки. При pending journal обычный startup запускает отдельный helper и завершается; CLI возвращает 75, поскольку запрошенная команда ещё не выполнялась. Специальный health mode остаётся read-only.

До первого swap/MSI effect сохраняются:

- helper в соседнем `.recovery-<id>` каталоге, вне заменяемого target;
- marker с target/profile/health token;
- SHA fingerprint прежнего payload и текущих данных профилей, включая SQLite DB/WAL, originals и receipts;
- долговечный journal и временная запись восстановления при входе пользователя в Windows.

Финальная реализация использует **HKCU Run**, а не RunOnce: запись удаляется после durable `healthy`/`rolled-back`, поэтому авария самого helper не должна терять возможность повторного запуска при следующем входе. Команда ограничена 260 символами, target/profile хранятся в marker; слишком длинный helper path отвергается до замены payload. Предел команды и отличие Run/RunOnce сверены с [Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys). Windows не гарантирует немедленный запуск при входе; ручной путь ниже остаётся доступен. Регистрация на этом этапе не выполнялась — изменён только код.

При `installed` recovery сначала пробует завершить read-only health. Для отката требуется совпадение fingerprint профилей: изменившийся schema/receipt/original/WAL или добавленные данные блокируют автоматический downgrade. Portable rollback дополнительно проверяет прежний payload и сохраняет `rollback-pending` до перемещения, чтобы повтор после остановки между restore и записью результата мог подтвердить уже восстановленный target. Previous/candidate/failed payloads не удаляются автоматически.

Старые journals без baseline не дают разрешение на автоматический rollback. Для них возможен forward health установленного payload; иначе нужен совместимый recovery. Старый health marker удаляется перед новой попыткой, stale helper от другого transaction отказывается работать. Helper не разрешает случайный запуск GUI из своего каталога.

Ручной recovery entry point: executable из `RecoveryHelper` в `<target>.neptune-update.json` с `--recover-update`. Его marker содержит target/profile, поэтому исходный target может отсутствовать. Для legacy journal helper запускается с `--target <installation> --profile <profile>`. Ни registry, ни пользовательские профили, ни установленные payloads в этой работе не изменялись.

## R04 / C12 — единый NameCodec

[Go NameCodec](C:/.projects/exocortex/pluto/internal/syncproto/name_codec.go) снимает ровно один трёхбайтовый `COM`/`LPT` prefix. Поэтому `COMLPT1.md` больше не сводится к reserved `LPT1`. В [общие vectors](C:/.projects/exocortex/saturn/packages/contracts/fixtures/name-codec-v1.json) добавлены accepted `COMLPT1.md`, `LPTCOM1.md`, `comlpt¹.md` и rejected `COM1.md`, `lpt³.md`. Векторы не выполнялись.

## R05 / C08–C16 — metadata storage admission

[DurableBackendExecutor](C:/.projects/exocortex/saturn/packages/storage/src/durable-backend-executor.ts) теперь проводит `stat`, `list`, `exists`, `statFs` через те же три SQL read slots, что и чтение bytes. Внутренние действия уже admitted writer и verifier остаются внутри своего слота и обращаются к raw adapter, избегая вложенного захвата.

Admission проверяет shutdown до ожидания и после получения SQL slot. Закрытие присоединяет pending read callbacks перед `read-close`. Добавлены metadata calls, admission wait и elapsed IO counters. Это реализация общего учёта, а не измеренное подтверждение лимита под нагрузкой.

## Проверка в этой работе и последующие гейты

Выполнено только чтение исходников, ручная трассировка SQL/state/call paths, сравнение с входными файлами, hashes и проверка whitespace diff с учётом CRLF. Компиляция и исполняемые проверки не выполнялись; PASS/ускорение не заявляются.

После отдельного разрешения нужны целевые проверки:

| Область | Проверки |
|---|---|
| R01 | Сохранённый профиль и phase timing; смешанная страница data/rename/hardlink; граница 40 значимых из 256; restart после commit; исходный timeout и сравнение результата proof. |
| R02 | Более 10 публикаций; pinned версии среди/за latest 10; concurrent pin; batch operation_key; pending stream/UNKNOWN; остановки до/после expiry, delete, ACK и receipt; same-ID recovery только после fence; защита current bytes/receipts; global limit 2; role qualification и worker shutdown. |
| R03 | Portable и MSI; остановка после каждого durable шага и во время rollback; отсутствующий target; обычный GUI/CLI startup; повторный login recovery; разные профили; stale helper/health marker; изменённый WAL/receipt/schema; старый journal без baseline; лимит пути. |
| R04 | Общие vectors в Go/C#/TypeScript, включая соседние reserved names. |
| R05 | Одновременные API/worker metadata + transfer/scrub; общий лимит; release при ошибке; shutdown во время SQL admission и raw IO; отсутствие nested acquisition у verifier/writer. |

Журнал: [.history/2026-10-14-stage-3-remediation.md](C:/.projects/exocortex/.history/2026-10-14-stage-3-remediation.md). Снимки до правок и финальные hashes: [changes.json](C:/.projects/exocortex/.audit/2026-10-14/stage-3-remediation/changes.json), соседний каталог `before`.
