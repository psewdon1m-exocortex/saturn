# Техническое решение Saturn: персональный файловый шлюз поверх Hetzner Storage Box

> Актуализация: прямой Telegram runtime, описанный ниже, вынесен в Gryphon.
> Saturn больше не хранит bot token, не принимает Telegram webhook и не
> управляет Telegram-провайдером; UI только вызывает service-scoped операции
> привязки и обновления самого Gryphon через локальные агенты. Saturn предоставляет Gryphon внутренний
> аутентифицированный адаптер команд. Разделы с прямой интеграцией сохранены
> как исходный исторический дизайн.

**Статус:** проект технической спецификации  
**Версия:** 1.1  
**Дата:** 1 сентября 2026 года  
**Целевая аудитория:** разработчик backend/frontend, DevOps-инженер, владелец системы

---

## 0. Резюме решения

Предлагается создать персональный файловый сервис, в котором **Hetzner Storage Box используется только как удалённый файловый носитель**, а всё пользовательское и машинное взаимодействие проходит через отдельный сервер-шлюз с публичным доменом и HTTPS.

Сервис должен совмещать два представления одних и тех же данных:

1. **Обычная файловая структура** — каталоги, файлы, перемещение, переименование, загрузка, скачивание.
2. **Логический граф** — дополнительные связи между файлами, папками и субъектами. Файл или каталог может одновременно относиться к нескольким субъектам, не создавая физических копий.

Рекомендуемая базовая архитектура:

```text
                          Интернет
                              │
                              ▼
                    drive.example.com
                              │ HTTPS
                    ┌─────────┴─────────┐
                    │  Gateway Service  │
                    │                   │
                    │ Web UI            │
                    │ REST API          │
                    │ WebDAV / Sync API │
                    │ Drop Point        │
                    │ Sharing           │
                    │ Telegram Bot      │
                    │ Backup Ingest     │
                    │ Laboratory Assets │
                    └─────────┬─────────┘
                              │ SFTP/SSH
                              ▼
                  Hetzner Storage Box
                    «тупое» хранилище

                    ┌───────────────────┐
                    │ PostgreSQL        │
                    │ metadata + audit  │
                    │ shares + audit    │
                    └───────────────────┘
```

Основные архитектурные решения:

- Storage Box не выдаёт свои учётные данные браузерам, ПК, Telegram, Laboratory или внутренним сервисам.
- На Storage Box включается только необходимый протокол SFTP; остальные протоколы отключаются.
- Если Gateway размещён в сети Hetzner, для Storage Box отключается External Reachability.
- Gateway использует отдельный sub-account Storage Box и SSH-ключ. Главная учётная запись Storage Box хранится офлайн как аварийный доступ.
- Физическая структура остаётся человекочитаемой и переносимой.
- Все объекты получают стабильные внутренние идентификаторы, не зависящие от пути.
- Удаление по умолчанию мягкое: файл перемещается в корзину, а не уничтожается.
- Перезапись создаёт предыдущую версию.
- Для больших загрузок применяется возобновляемая передача по протоколу tus или эквивалентному chunked upload.
- Для синхронизации ПК Gateway публикует собственный WebDAV или специализированный Sync API; прямой WebDAV/SFTP Storage Box пользователю не выдаётся.
- Ссылки для Laboratory и внешнего sharing всегда используют собственный домен и стабильный ID, а не адрес или путь Hetzner.
- Вся provider-specific логика скрывается за `StorageAdapter`, чтобы в будущем заменить Storage Box на S3, NAS, MinIO или другой файловый backend.

---

# 1. Определения

## 1.1. Storage Box

Арендованное удалённое файловое хранилище Hetzner. Оно хранит каталоги и файлы и доступно через стандартные протоколы, включая SFTP, SCP, rsync/Borg через SSH, SMB и WebDAV. В рамках данного проекта Storage Box не является приложением и не предоставляет пользовательский интерфейс.

## 1.2. Gateway

Собственный сервер и приложение, через которое проходят все внешние операции: загрузка, скачивание, синхронизация, sharing, резервные копии, Telegram-коды, интеграция с Laboratory и работа с графом.

## 1.3. Resource

Файл или папка, зарегистрированные в системе и имеющие стабильный `resource_id`.

## 1.4. Физическая иерархия

Единственное реальное расположение файла в каталогах Storage Box. У каждого файла или папки может быть только один физический родитель.

## 1.5. Subject

Логическая сущность, с которой можно связать ресурс. Примеры: человек, модель, фотосессия, проект, тема, документ, организация, место, событие.

## 1.6. Edge

Направленная или ненаправленная связь между двумя узлами графа. Узлом может быть Resource или Subject.

## 1.7. Drop Point

Минимальная публичная страница, позволяющая загрузить один или несколько файлов в каталог `drop point` по короткоживущему многоклиентскому коду, полученному через Telegram-бота. Drop Point не показывает содержимое хранилища и не позволяет скачивать, переименовывать или удалять данные.

## 1.8. Mastermind

Полный каталог Obsidian vault: Markdown-файлы, вложения, подпапки и служебная директория `.obsidian`. Он хранится как обычная папка и синхронизируется с выбранными ПК.

## 1.9. Laboratory

Собственная платформа для написания и публикации статей. Она получает тяжёлые файлы не напрямую, а по стабильным ссылкам Gateway.

## 1.10. Backup Producer

Внутренний сервис, который периодически формирует резервную копию и загружает её в Gateway по отдельной машинной учётной записи.

## 1.11. Share

Публичное или защищённое правило доступа к файлу/папке через собственный домен. Share имеет токен, режим, срок действия, опциональный пароль и журнал обращений.

---

# 2. Цели и границы проекта

## 2.1. Обязательные цели

Система должна обеспечивать:

1. Собственный web-интерфейс для работы с файлами и папками.
2. Быструю загрузку файлов через Drop Point по короткоживущему Telegram-коду с общей очередью для нескольких устройств.
3. Хранение и синхронизацию каталога Mastermind.
4. Безопасное хранение и версионирование KeePass-файла.
5. Приём автоматических резервных копий внутренних сервисов с отдельной аутентификацией.
6. Обычное представление файловой структуры.
7. Графическое представление ресурсов и их отношений к нескольким субъектам.
8. Синхронизацию выбранных каталогов с ПК исключительно через Gateway.
9. Интеграцию с Laboratory через стабильные ссылки на тяжёлые файлы.
10. Sharing файлов и папок по внешним ссылкам с режимами доступа, сроком действия и опциональным паролем.
11. Защиту от случайного удаления, перезаписи, неполной загрузки и потери metadata.
12. Простой и проверяемый выход от Hetzner к другому хранилищу.

## 2.2. Необязательные цели первой версии

Можно отложить:

- нативные приложения iOS/Android;
- совместное редактирование документов в браузере;
- мультитенантность и коммерческие тарифы;
- полнотекстовый OCR всех документов;
- AI-классификацию и автоматическое построение всех связей;
- публичный CDN для массовой раздачи файлов;
- отдельную графовую СУБД;
- zero-knowledge encryption всего архива.

## 2.3. Нефункциональные требования

- **Переносимость:** файлы остаются обычными файлами и каталогами.
- **Обратимость:** опасные операции имеют корзину, версии или журнал восстановления.
- **Модульность:** provider-specific код отделён от бизнес-логики.
- **Наблюдаемость:** все значимые операции логируются и имеют статус.
- **Минимизация секретов:** внешние клиенты не получают Storage Box credentials.
- **Потоковая обработка:** большие файлы не должны целиком помещаться на диск или в RAM Gateway.
- **Идемпотентность:** повтор запроса после обрыва не создаёт неконтролируемых дублей.
- **Независимость ссылок:** публичные URL не содержат физические пути Storage Box.

---

# 3. Выбранная архитектура

## 3.1. Тип приложения

Рекомендуется **модульный монолит**, а не набор микросервисов.

Один репозиторий и один основной backend позволяют упростить развертывание, резервное копирование и обновление, но внутри кода должны существовать независимые модули:

```text
Gateway
├── auth
├── storage
├── files
├── drop
├── telegram
├── shares
├── backups
├── sync
├── laboratory
├── preview
├── audit
└── jobs
```

Модули общаются через явные интерфейсы и сервисный слой. Прямой доступ frontend или отдельных обработчиков к SFTP запрещён.

## 3.2. Рекомендуемый стек

### Backend

- Go как reference implementation.
- Причины: удобная потоковая передача, ограниченное потребление памяти, хороший контроль конкурентности, возможность собрать один бинарный файл.
- Допустима реализация на TypeScript/NestJS, если разработчик увереннее в этом стеке; интерфейсы и состояния должны остаться теми же.

### Frontend

- React + Vite или Vue.
- Отдельный SPA необязателен: допустимо server-side приложение с интерактивными компонентами.

### База данных

- PostgreSQL.
- Граф реализуется таблицей рёбер; Neo4j для одного пользователя не нужен.
- Redis не требуется в MVP: фоновые задачи можно хранить в PostgreSQL.

### Reverse proxy

- Caddy или Nginx.
- Обязанности: TLS, ограничения размера и скорости запросов, security headers, проксирование, access logs.

### Передача больших файлов

- tus resumable upload либо собственный совместимый chunked upload.
- Сервер принимает части, записывает их в временный файл на Storage Box и фиксирует подтверждённый offset.

### Связь с Storage Box

- Только SFTP поверх SSH.
- Долгоживущий ограниченный pool соединений.
- Без системного mount через SSHFS в качестве основной производственной модели.

## 3.3. Компоненты

| Компонент | Ответственность |
|---|---|
| Reverse proxy | HTTPS, маршрутизация, rate limit, лимиты тела, базовые заголовки безопасности |
| Gateway API | Авторизация, операции над ресурсами, shares, backups, Laboratory |
| Web UI | Файловый менеджер, Drop Point, backups, shares |
| StorageAdapter | Единый интерфейс к Storage Box; скрывает SFTP |
| Worker | Хеширование, индексация, версии, retention, reconciliation, упаковка папок |
| PostgreSQL | Метаданные, версии, сессии, shares, audit, очереди |
| Telegram module | Получение команды, выдача и отзыв Drop-кодов |
| WebDAV/Sync endpoint | Синхронизация ПК через Gateway |
| Storage Box | Физические файлы, системные каталоги, временные объекты |

---

# 4. Граница безопасности

## 4.1. Основное правило

```text
Ни браузер, ни ПК, ни Laboratory, ни backup producer
не знают адрес, пароль или SSH-ключ Storage Box.
```

Единственная рабочая учётная запись Storage Box находится на Gateway.

## 4.2. Настройка Storage Box

Рекомендуемая конфигурация:

1. Создать отдельный sub-account, например `gateway`.
2. Все данные сервиса хранить внутри каталога этого sub-account.
3. Gateway подключать по SSH-ключу.
4. Для sub-account задать длинный случайный пароль и хранить его офлайн; Hetzner не позволяет полностью отключить password authentication.
5. Включить только SFTP. FTP, SMB, WebDAV и расширенный SSH порт 23 не включать без необходимости.
6. Если Gateway расположен внутри сети Hetzner, отключить External Reachability.
7. Главную учётную запись Storage Box и её восстановительные данные не хранить на Gateway; использовать их только как break-glass доступ.

## 4.3. Публичная поверхность Gateway

Открыты:

- TCP 443 — web, API, Drop Point, shares, Telegram webhook, WebDAV;
- TCP 80 — только перенаправление на HTTPS, если требуется.

Административный SSH:

- только через VPN, identity-aware proxy или IP allowlist;
- вход по ключу;
- root login и password login отключены.

## 4.4. Аварийный доступ

При полном отказе Gateway допускается временно:

1. включить External Reachability Storage Box;
2. подключиться главной учётной записью или отдельным аварийным sub-account;
3. выгрузить или проверить данные;
4. снова отключить внешний доступ.

Аварийный путь не должен использоваться ежедневно, но обязан быть документирован и проверен.

---

# 5. Физическая структура Storage Box

Корень данных Gateway совпадает с начальным каталогом, выданным Storage Box
sub-account. В production это выражается конфигурацией `STORAGE_ROOT=.`. Обёртки
`gateway/` и `drive/` не используются.

Каноническая структура:

```text
<sub-account home>/                  # STORAGE_ROOT=.
├── drop point/
├── laboratory/
├── backups/
│   ├── gateway/
│   ├── service-a/
│   ├── service-b/
│   └── manifests/
├── mastermind/
├── volt/
│   └── passwords.kdbx
├── sync/
└── _system/
    ├── incoming/
    ├── versions/
    ├── trash/
    ├── packages/
    ├── previews/
    ├── metadata-exports/
    └── orphaned/
```

## 5.1. Почему пути должны быть человекочитаемыми

Даже при наличии базы данных архив должен сохранять смысл без Gateway. Если metadata потеряна, владелец должен увидеть обычные каталоги и файлы через аварийный SFTP.

## 5.2. Политика корневых каталогов

Шесть предустановленных каталогов `drop point`, `laboratory`, `backups`,
`mastermind`, `volt` и `sync` имеют стабильные resource ID. Пользователь может
переименовать каждый из них, но не может удалить, вырезать, переместить или
скопировать сам предустановленный корень. Защита следует за ID и не зависит от
текущего имени.

Пользователь может создавать в корне любое количество обычных папок в пределах
общей ёмкости и эксплуатационных квот, а затем
переименовывать, копировать, перемещать и отправлять их в обратимую корзину.
Файлы непосредственно в корне не размещаются: для загрузки сначала создаётся
или открывается папка. Исходные имена шести предустановленных каталогов остаются
зарезервированными, чтобы обычная папка не подменила системную роль.

`_system` — скрытое неизменяемое внутреннее пространство для атомарных загрузок,
версий, корзины и восстановления. Оно не представлено пользовательским ресурсом
и исключено из обычных файловых операций.

Привязка прикладных сервисов к переименованным `laboratory`, `backups`,
`mastermind`, `volt` и другим ролевым корням выполняется отдельным следующим
изменением. До него переименование разрешено файловым ядром, но модуль с
жёстко заданным legacy-путём может временно потерять свою рабочую директорию.

## 5.3. Временные загрузки

Каждая загрузка сначала записывается как:

```text
_system/incoming/<upload_id>.part
```

После завершения:

1. сверяется ожидаемый размер;
2. завершается SHA-256;
3. проверяется, что upload session активна;
4. временный файл переименовывается в конечный путь;
5. ресурс переводится в `ACTIVE`.

Неполные `.part` автоматически удаляются после заданного TTL, например 24 часов.

## 5.4. Запрет опасных конструкций

- Не поддерживать symbolic links в пользовательской части.
- Запрещать `..`, абсолютные пути, NUL и управляющие символы.
- Нормализовать Unicode в единый формат.
- Ограничить длину имени и полного пути.
- Не исполнять загруженные файлы.
- Не хранить пользовательские файлы в webroot Gateway.

---

# 6. Модель данных и граф

## 6.1. Главный принцип

Физическое расположение и логическая принадлежность разделены.

```text
Физически:
/Photos/Catalog_N/

Логически:
Catalog_N ──associated_with──> Model_M
Catalog_N ──associated_with──> «Мои фотосессии»
Catalog_N ──shot_in───────────> Location_X
```

Файл или папка физически существует один раз, но может иметь любое число логических связей.

## 6.2. Стабильные идентификаторы

Каждому Resource и Subject назначается UUIDv7 или другой сортируемый уникальный ID.

```text
resource_id = 0191f4d4-...
```

ID не меняется при:

- переименовании;
- перемещении;
- смене Storage Box;
- переносе на S3/NAS;
- изменении публичной ссылки.

## 6.3. Базовые сущности

### `resources`

| Поле | Назначение |
|---|---|
| id | Стабильный ID |
| type | file / folder |
| parent_id | Физический родитель |
| name | Отображаемое имя |
| storage_path | Текущий путь в backend |
| mime_type | Определённый MIME |
| size_bytes | Размер |
| sha256 | Контрольная сумма файла |
| current_version_id | Текущая версия |
| status | pending / active / trashed / error |
| created_at / updated_at | Время |

### `subjects`

| Поле | Назначение |
|---|---|
| id | ID субъекта |
| type | person / model / project / topic / location / custom |
| name | Название |
| properties | JSONB с дополнительными полями |

### `edges`

| Поле | Назначение |
|---|---|
| id | ID связи |
| from_node_id | Исходный узел |
| to_node_id | Целевой узел |
| relation_type | Тип отношения |
| direction | directed / undirected |
| source | manual / derived / inherited |
| propagate | Наследовать ли связь дочерними ресурсами |
| properties | JSONB |
| created_at | Время |

### `file_versions`

| Поле | Назначение |
|---|---|
| id | ID версии |
| resource_id | Ресурс |
| storage_path | Путь версии |
| sha256 | Хеш |
| size_bytes | Размер |
| created_at | Время |
| reason | overwrite / sync-conflict / manual |

## 6.4. Типы связей первой версии

- `associated_with` — общая связь;
- `belongs_to` — принадлежность субъекту или коллекции;
- `depicts` — файл изображает человека/модель/объект;
- `created_for` — создано для проекта/задачи;
- `part_of` — логическая часть;
- `references` — ресурс ссылается на другой ресурс;
- `derived_from` — производный файл;
- `version_of` — версия объекта;
- `related_to` — нейтральная связь;
- `located_at` — место;
- `created_by` — автор.

Типы должны храниться в справочнике и расширяться без миграции основной схемы.

## 6.5. Наследование связей папки

Связь папки может иметь `propagate = true`.

Пример:

```text
Catalog_N ──depicts, propagate──> Model_M
```

Тогда UI показывает, что вложенные файлы относятся к Model_M по наследованию, но не создаёт физические копии рёбер для каждого файла. Пользователь должен видеть различие:

- **direct** — связь задана самому файлу;
- **inherited** — получена от родительского каталога.

## 6.6. Граф Obsidian и общий граф

Для Markdown-файлов Mastermind indexer может извлекать:

- `[[wikilinks]]`;
- стандартные Markdown-ссылки;
- ссылки на вложения;
- YAML frontmatter.

Извлечённые связи создаются с `source = derived`. Они не должны изменять исходные Markdown-файлы и могут быть пересобраны.

Ручные связи пользователя хранятся отдельно и не удаляются при повторной индексации.

## 6.7. Экспорт графа

Система обязана экспортировать:

- `resources.jsonl`;
- `subjects.jsonl`;
- `edges.jsonl`;
- `shares.jsonl` без секретных токенов;
- `manifest.json` с версией схемы.

Экспорт создаётся по расписанию и сохраняется в `_system/metadata-exports`.

---

# 7. StorageAdapter и независимость от провайдера

Все операции с файлами проходят через интерфейс:

```go
interface StorageAdapter {
    Stat(path) FileInfo
    List(path, cursor, limit) []FileInfo
    OpenRead(path, offset, length) Reader
    OpenWrite(path, offset) Writer
    Mkdir(path)
    Rename(source, destination)
    Copy(source, destination)
    Delete(path)
    Exists(path) bool
    StatFS() Capacity
}
```

Первая реализация:

```text
SFTPStorageAdapter → Hetzner Storage Box
```

Будущие реализации:

```text
S3StorageAdapter   → Backblaze B2 / R2 / Hetzner Object Storage
LocalStorage       → NAS / local filesystem
MinIOStorage       → собственный S3
```

Frontend, shares и Laboratory не должны содержать ветвлений вида `if provider == hetzner`.

## 7.1. Ограничение соединений

Storage Box ограничивает число одновременных соединений на аккаунт. Gateway должен использовать semaphore/pool, например:

```text
максимум 8 активных SFTP-соединений
├── 4 user upload/download
├── 2 backups/sync
├── 1 background indexer
└── 1 reserve/admin
```

Запросы сверх лимита помещаются в короткую очередь, а не создают новые соединения бесконтрольно.

## 7.2. Не использовать постоянный SSHFS mount как основу

Причины:

- зависание mount может блокировать процессы;
- сложнее отличать локальную ошибку от сетевой;
- труднее реализовать retries, offsets и idempotency;
- внезапный reconnect может давать неоднозначные результаты.

Mount допустим только для аварийного обслуживания или прототипа.

---

# 8. Согласованность операций

Storage Box и PostgreSQL не поддерживают общую распределённую транзакцию. Поэтому каждая операция должна иметь конечный автомат состояний и возможность reconciliation.

## 8.1. Загрузка

```text
CREATED
  ↓
UPLOADING
  ↓
VERIFYING
  ↓
COMMITTING
  ↓
ACTIVE
```

Ошибочные состояния:

```text
FAILED_RETRYABLE
FAILED_FINAL
ABANDONED
```

Алгоритм:

1. Создать `upload_session` в БД.
2. Выделить временный путь `.part`.
3. Принимать поток/части.
4. После каждого chunk фиксировать offset.
5. На завершении проверить размер и SHA-256.
6. Заблокировать конечное имя.
7. Если файл заменяется — перенести старую версию в `_system/versions`.
8. Переименовать `.part` в конечный путь.
9. Зафиксировать Resource и Version в БД.
10. Записать audit event.

## 8.2. Перемещение и переименование

1. Получить advisory lock на `resource_id`.
2. Проверить права и отсутствие конфликтующего имени.
3. Выполнить rename на Storage Box.
4. Обновить `storage_path` и parent в БД.
5. Записать change journal.
6. При ошибке БД reconciliation должен обнаружить новый путь по audit operation ID или hash.

## 8.3. Удаление

Обычный DELETE не уничтожает файл:

```text
/sync/Documents/a.pdf
        ↓
/_system/trash/2026/08/<resource_id>/a.pdf
```

Resource получает статус `TRASHED` и `purge_after`.

Окончательное удаление:

- только после retention;
- отдельной фоновой задачей;
- с повторной авторизацией для ручного purge;
- с audit event.

## 8.4. Перезапись

Перед заменой текущий файл переносится в:

```text
/_system/versions/<resource_id>/<version_id>/<filename>
```

После этого новая версия становится активной.

## 8.5. Reconciliation

Фоновая задача сравнивает БД и Storage Box:

- файлы в Storage Box без Resource → `orphaned`;
- Resource без файла → alert и статус `MISSING`;
- несовпадение размера → alert;
- несовпадение хеша → incident;
- зависшие `.part` → cleanup;
- просроченные packages/previews → cleanup.

Полный hash scan дорогой, поэтому:

- размер/mtime проверяются ежедневно;
- выборочный hash scrub — еженедельно;
- полный hash scrub — по запросу или перед миграцией.

---

# 9. Web-интерфейс

## 9.1. Основные экраны

```text
Files | Laboratory | Drop Point | Shared | Trash | Activity | Settings
```

### Files

- дерево папок;
- breadcrumbs;
- drag-and-drop upload;
- создание папок;
- rename/move/copy;
- multi-select;
- preview;
- download;
- share;
- версии;
- корзина.

### Drop Point

- новые файлы из Drop Point;
- источник загрузки;
- дата;
- быстрый move;
- назначение субъектов;
- статус обработки.

### Backups

- последний успешный backup каждого сервиса;
- размер;
- checksum;
- retention;
- ошибки;
- результат последнего restore test.

### Shared

- активные ссылки;
- срок действия;
- режим;
- число скачиваний;
- ручной revoke.

## 9.2. Быстрая загрузка после полной авторизации

На любой странице доступна кнопка Quick Upload. По умолчанию файлы попадают в `drop point` без выбора каталога.

## 9.3. Preview

Первая версия может поддерживать:

- изображения;
- PDF;
- текст/Markdown;
- аудио;
- видео с Range;
- metadata для архивов без распаковки.

Офисные документы допускается только скачивать либо конвертировать в изолированном worker.

---

# 10. Drop Point и Telegram-бот

## 10.1. Пользовательский сценарий

1. Пользователь на доверенном телефоне пишет боту `/drop` или нажимает кнопку «Получить код».
2. Bot проверяет Telegram `user_id` по allowlist.
3. Gateway создаёт короткоживущий код общего Drop-канала.
4. Bot отправляет код и срок действия.
5. На чужом устройстве пользователь открывает `https://drive.example.com/drop`.
6. Вводит код.
7. Получает upload-only session.
8. Перетаскивает файлы.
9. После завершения Telegram присылает уведомление.
10. Файлы появляются в `/drop point/<date>/`.

## 10.2. Параметры кода по умолчанию

| Параметр | Значение по умолчанию |
|---|---|
| Формат | 8 символов Crockford Base32 |
| Срок действия | 30 минут от выпуска |
| Число погашений | несколько, пока код действует |
| Drop channel и client sessions | до того же срока: 30 минут от выпуска |
| Максимум файлов | 20 |
| Максимум batch | 20 GB |
| Права | только upload |
| Просмотр файлов | запрещён |
| Overwrite | запрещён |

Код не передаётся в URL query, чтобы не попадать в browser history, reverse proxy logs и Referer. Он отправляется в POST body.

## 10.3. Хранение кода

В БД не хранится открытый код. Хранятся:

- `code_hash` или HMAC;
- `expires_at`;
- `redeemed_at`;
- `telegram_user_id`;
- лимиты;
- статус.

Каждое успешное погашение в пределах срока выдаёт устройству отдельную HttpOnly cookie Drop session. Все такие сессии входят в один канал, разделяют очередь и прекращают действие в общей точке — через 30 минут после выпуска кода.

## 10.4. Защита от перебора

- не более 5 неверных попыток на IP за 15 минут;
- глобальный лимит попыток;
- задержка после ошибок;
- CAPTCHA только при аномалии, не по умолчанию;
- уведомление в Telegram о подозрительных попытках;
- кнопка `/revoke` для отзыва всех активных Drop sessions.

## 10.5. Telegram webhook

- использовать HTTPS webhook;
- задать Telegram `secret_token` и проверять заголовок webhook;
- принимать только необходимые update types;
- проверять `from.id`, а не username;
- bot token хранить в secret store;
- дедуплицировать updates по `update_id`.

## 10.6. Ограничение риска чужого устройства

Drop-код не защищает от malware/keylogger на устройстве, но ограничивает ущерб:

- код короткоживущий;
- допускает несколько устройств только в пределах общего абсолютного срока;
- не открывает архив;
- не позволяет скачать KeePass;
- не позволяет удалить/перезаписать существующие данные;
- batch ограничен по объёму.

---

# 11. Mastermind: хранение Obsidian vault

## 11.1. Хранилище

Mastermind хранится целиком:

```text
/mastermind/
├── *.md
├── attachments/
├── templates/
├── ...
└── .obsidian/
```

Obsidian vault по своей природе является обычной локальной папкой с Markdown-файлами и подпапками, поэтому он хорошо соответствует данной модели.

## 11.2. Синхронизация

Для Mastermind допускается двусторонняя синхронизация:

```text
PC folder ⇄ Gateway Sync API/WebDAV ⇄ Storage Box
```

Каждое устройство получает отдельный device token с scope только на `/mastermind`.

## 11.3. Конфликты

Если удалённая версия изменилась после последнего sync base:

- исходная версия не перезаписывается;
- создаётся conflict copy:

```text
note (conflict 2026-08-21 laptop).md
```

- обе версии регистрируются;
- пользователю отправляется уведомление.

## 11.4. Особые файлы `.obsidian`

По умолчанию сохраняется вся директория. При частых конфликтах можно отдельно исключить device-specific workspace state, но список исключений должен быть явным и версионируемым.

## 11.5. Индексация ссылок

Indexer читает Markdown и создаёт derived edges, не изменяя документы. Ошибка парсера не должна блокировать upload/sync.

## 11.6. Версионирование Mastermind

Предлагаемая политика:

- Markdown: до 100 версий или 30 дней;
- вложения: до 10 версий или 30 дней;
- удалённые файлы: корзина 90 дней.

---

# 12. KeePass-файл

## 12.1. Режим хранения

KeePass database хранится как **opaque encrypted file**. Gateway:

- не анализирует содержимое;
- не создаёт preview;
- не индексирует;
- не разрешает публичный share по умолчанию;
- не открывает KDBX на сервере.

KeePass шифрует всю database, включая пароли, usernames, URL и notes, но файл всё равно требует усиленного контроля доступа.

## 12.2. Дополнительные требования

- папка `volt` скрыта из Drop Point и Laboratory;
- скачивание и замена требуют re-authentication;
- device token для общего sync не получает эту папку без отдельного scope;
- каждое изменение создаёт версию;
- старые версии хранятся минимум 90 дней;
- checksum проверяется после upload;
- overwrite выполняется через temp + rename.

## 12.3. Синхронизация KeePass

Поддержать два режима:

1. **Файловый sync клиента** через Gateway WebDAV.
2. **KeePass Synchronize with URL/File**, если выбранный KeePass-клиент это поддерживает.

Не рекомендуется одновременно редактировать одну базу на нескольких устройствах без встроенной синхронизации KeePass. При конфликте Gateway обязан сохранить обе версии.

## 12.4. Recovery

Не реже одного раза в квартал проверять:

- скачивание последней версии;
- открытие с master key;
- открытие одной старой версии;
- наличие независимой копии KDBX вне Storage Box.

---

# 13. Автоматические резервные копии внутренних сервисов

## 13.1. Общая схема

```text
Service A ──HTTPS + service token──┐
Service B ──HTTPS + service token──┼──> Gateway ──SFTP──> Storage Box
Service C ──mTLS + token───────────┘
```

Ни один сервис не получает Storage Box credentials.

## 13.2. Service identity

Для каждого сервиса создаются:

- `service_id`;
- отдельный случайный API token;
- allowed backup path;
- максимальный размер;
- частота;
- quota;
- retention policy;
- optional mTLS certificate;
- allowed source IP/CIDR, если адрес стабилен.

Токены должны быть уникальными и ротируемыми. Открытый token показывается один раз, в БД хранится его hash/HMAC.

## 13.3. Backup protocol

Рекомендуемый flow:

1. `POST /api/v1/backups/{service_id}/runs`
2. Передать metadata:
   - filename;
   - created_at;
   - backup type;
   - expected size;
   - sha256;
   - source version;
   - encryption flag.
3. Получить `run_id` и upload URL.
4. Загрузить данные resumable chunks.
5. `POST /complete`.
6. Gateway проверяет hash, переносит файл в final path и возвращает receipt.

Пример пути:

```text
/backups/service-a/2026/08/21/2026-08-21T03-00-00Z_full_<run_id>.tar.zst.age
```

## 13.4. Шифрование backups

Предпочтительно, чтобы чувствительные backups шифровались на стороне producer до отправки, например `age`, restic или собственным механизмом сервиса. Тогда компрометация Gateway не раскрывает backup content.

Ключ восстановления не должен храниться только на том же Gateway.

## 13.5. Retention

Базовая политика:

```text
Daily   × 7
Weekly  × 4
Monthly × 12
Yearly  × 3 — при необходимости
```

Retention задаётся отдельно для каждого сервиса.

## 13.6. Проверка восстановления

Backup считается успешным только после:

- успешного upload;
- совпадения checksum;
- регистрации manifest;
- периодического restore test.

Не реже раза в месяц worker должен восстановить тестовую копию выбранного сервиса в изолированную среду либо выполнить проверку архива/дампа.

## 13.7. Защита от компрометации producer

Service token должен разрешать только:

- создать новый backup;
- продолжить собственный незавершённый upload;
- получить статус собственного run.

Он не должен позволять:

- читать старые backups;
- удалять backups;
- видеть файлы Drive;
- изменять retention;
- получать список других сервисов.

---

# 14. Обычная файловая структура

## 14.1. Основное представление

Обычный файловый менеджер остаётся главным интерфейсом. Граф — дополнительная проекция.

```text
Drive
├── Archive
├── Documents
├── Photos
├── Projects
├── mastermind
├── volt
└── Laboratory
```

## 14.2. Операции

- list;
- upload;
- download;
- create folder;
- rename;
- move;
- copy;
- soft delete;
- restore;
- inspect versions;
- search by name;
- attach subjects;
- create share.

## 14.3. Поиск

MVP:

- filename;
- path;
- MIME;
- subject;
- relation;
- date;
- source.

Позже:

- full-text Markdown/PDF;
- EXIF;
- OCR;
- embeddings.

---

# 15. Синхронизация файлов и папок с ПК

## 15.1. Ограничение

ПК не подключается напрямую к Storage Box. Он обращается только к Gateway.

## 15.2. MVP: WebDAV Gateway

Gateway публикует:

```text
https://drive.example.com/dav/
```

WebDAV handler вызывает тот же `FileService` и `StorageAdapter`, что и web UI. Это важно: metadata, versioning и audit должны обновляться независимо от клиента.

WebDAV должен поддерживать минимум:

- PROPFIND;
- GET/HEAD;
- PUT;
- MKCOL;
- MOVE;
- COPY;
- DELETE;
- ETag/If-Match;
- Range для download.

## 15.3. Device tokens

Каждый ПК получает отдельный app password/token:

```text
device: main-laptop
scope: /mastermind, /sync
rights: read, write, move, delete
expires: optional
```

Token можно отозвать, не меняя основной пароль.

## 15.4. Клиенты первой версии

- rclone через WebDAV;
- FreeFileSync или другой WebDAV-capable client;
- собственный небольшой CLI-wrapper;
- системный WebDAV mount — только для ручного доступа, не как гарантированный sync engine.

## 15.5. Односторонний и двусторонний режим

### Архив

```text
PC → Gateway
```

Рекомендуется copy/backup без распространения локальных удалений.

### Mastermind и рабочая папка

```text
PC ⇄ Gateway
```

Допускается двусторонняя синхронизация с conflict detection.

## 15.6. Phase 2: собственный Sync Agent

Позже можно создать tray/CLI agent с API:

```text
GET  /api/v1/sync/changes?cursor=...
POST /api/v1/sync/files/{id}/content
POST /api/v1/sync/moves
POST /api/v1/sync/deletes
```

Agent хранит локальную SQLite:

- device_id;
- resource_id;
- path;
- local hash;
- remote version;
- last sync cursor.

Преимущества над универсальным WebDAV:

- стабильные resource_id;
- корректное распознавание move;
- selective sync;
- понятные конфликты;
- delta journal;
- меньше полного scanning.

---

# 16. Интеграция с Laboratory

## 16.1. Основное правило

Markdown Laboratory не должен содержать:

- Storage Box hostname;
- SFTP path;
- временный share token;
- provider-specific URL.

Используется собственный стабильный asset URL:

```text
https://drive.example.com/a/<asset_id>/<filename>
```

## 16.2. Примеры Markdown

Изображение:

```markdown
![Описание](https://drive.example.com/a/0191.../image.webp)
```

Файл для скачивания:

```markdown
[Скачать исходник](https://drive.example.com/a/0191.../archive.zip)
```

Видео:

```html
<video controls src="https://drive.example.com/a/0191.../video.mp4"></video>
```

## 16.3. Режимы asset

### Public immutable

- доступ без авторизации;
- пригоден для опубликованной статьи;
- ссылка указывает на конкретную version;
- длительный cache-control.

### Public mutable alias

- стабильный asset ID указывает на current version;
- удобно обновлять файл без редактирования Markdown;
- кэш должен использовать ETag/revalidation.

### Private

- доступен только Laboratory backend по service token;
- либо выдаётся короткоживущий signed Gateway token;
- не должен использоваться в полностью публичной статье без proxy.

## 16.4. Publish flow

1. Пользователь выбирает файл в Gateway.
2. Нажимает «Использовать в Laboratory».
3. Gateway создаёт asset и режим доступа.
4. Возвращает готовый Markdown fragment.
5. Laboratory вставляет fragment.
6. При перемещении физического файла `asset_id` остаётся прежним.

## 16.5. Производительность

Asset endpoint должен поддерживать:

- HTTP Range и `206 Partial Content`;
- ETag;
- Last-Modified;
- Content-Length;
- корректный Content-Type;
- `inline` или `attachment`;
- ограничение скорости при необходимости.

Range необходим для возобновления downloads, PDF viewers и перемотки media.

## 16.6. Массовый трафик

Storage Box + Gateway не является CDN. При росте публичных просмотров Laboratory следует добавить cache/CDN перед публичным `/a/`, оставив Gateway источником авторизации и origin.

---

# 17. Sharing файлов и папок

## 17.1. URL

```text
https://drive.example.com/s/<high_entropy_token>
```

Token генерируется криптографически стойким RNG, содержит не менее 128 бит энтропии и не включает ID ресурса.

## 17.2. Параметры Share

| Параметр | Варианты |
|---|---|
| Resource | file / folder |
| Срок | 1 час / 1 день / 7 дней / дата / бессрочно |
| Режим | view / download / browse folder / download folder |
| Пароль | optional |
| Max downloads | optional |
| IP/CIDR | optional |
| Watermark/preview | later |
| Allow listing | для папки |

## 17.3. Пароль Share

Пароль хранится только в виде Argon2id hash. После успешного ввода создаётся короткая share-session cookie, чтобы не запрашивать пароль на каждый Range request.

## 17.4. View-only: реальное ограничение

Режим «только смотреть» означает:

- Gateway отдаёт `Content-Disposition: inline`;
- UI не показывает кнопку download;
- можно отключить прямой листинг и ограничить тип preview.

Но если браузер получил содержимое изображения, PDF, audio или video, технически невозможно гарантировать, что получатель не сохранит его или не сделает копию. Документация и UI не должны обещать абсолютную защиту от скачивания.

## 17.5. Передача файла

Gateway не сохраняет весь файл на своём диске:

```text
Storage Box ──SFTP stream──> Gateway ──HTTPS stream──> Recipient
```

Нужен небольшой buffer и поддержка backpressure.

## 17.6. Range и возобновление

Для большого файла Gateway:

1. читает заголовок `Range`;
2. проверяет границы;
3. делает seek/open на нужном offset в SFTP;
4. возвращает `206 Partial Content` и `Content-Range`.

## 17.7. Папки

### Browse mode

Показывается read-only дерево разрешённой папки. Дочерние пути не могут выйти за root share.

### Download as archive

Для маленькой папки ZIP можно формировать потоково.

Для большой папки лучше:

1. создать background package;
2. сохранить ZIP/TAR.ZST в `_system/packages/<share_id>`;
3. показать прогресс;
4. после готовности разрешить Range download;
5. удалить package после expiry.

## 17.8. Отзыв

Share должен немедленно перестать работать при:

- ручном revoke;
- expiry;
- достижении max downloads;
- перемещении ресурса в trash;
- изменении security classification на более строгую.

---

# 18. API: рекомендуемый контракт

Runtime storage replacement is exposed only to an authenticated owner with
recent proof: `GET /api/v1/operator/storage`, `POST
/api/v1/operator/storage/test`, and `POST /api/v1/operator/storage/switch`.
The test/switch bodies accept the SFTP target and one write-only password or
private key. Read responses never contain credential material. Switching means
activation of an independent file set, a complete Gateway catalog rebuild and
zero byte migration; the previous backend is not modified. API and worker read
the atomically published profile from the shared protected
`STORAGE_RUNTIME_CONFIG_DIR`.

## 18.1. Authentication modes

| Режим | Для кого | Права |
|---|---|---|
| Full user session | Web UI | полный доступ |
| Drop session | чужое устройство | upload-only в `drop point` |
| Device token | ПК sync | ограниченные paths/actions |
| Service token | backup producer/Laboratory | конкретный API scope |
| Share token | внешний получатель | только конкретный Share |
| Admin token | обслуживание | внутренний, не для browser |

## 18.2. Files

```text
GET    /api/v1/resources/{id}
GET    /api/v1/folders/{id}/children
POST   /api/v1/folders
POST   /api/v1/uploads
PATCH  /api/v1/resources/{id}
POST   /api/v1/resources/{id}/move
POST   /api/v1/resources/{id}/copy
DELETE /api/v1/resources/{id}
POST   /api/v1/resources/{id}/restore
GET    /api/v1/files/{id}/content
GET    /api/v1/files/{id}/versions
POST   /api/v1/files/{id}/versions/{version_id}/restore
```

## 18.3. Resumable uploads

```text
POST   /api/v1/uploads
HEAD   /api/v1/uploads/{upload_id}
PATCH  /api/v1/uploads/{upload_id}
POST   /api/v1/uploads/{upload_id}/complete
DELETE /api/v1/uploads/{upload_id}
```

Либо полностью совместимый tus endpoint.

## 18.4. Drop Point

```text
POST /api/v1/drop/redeem
POST /api/v1/drop/uploads
GET  /api/v1/drop/uploads/{id}/status
POST /api/v1/drop/complete
```

## 18.5. Telegram

```text
POST /internal/telegram/webhook
```

Команды:

- `/drop`;
- `/revoke`;
- `/status`;
- `/last_uploads` — optional.

## 18.6. Backups

```text
POST /api/v1/backups/{service_id}/runs
HEAD /api/v1/backups/{service_id}/runs/{run_id}/upload
PATCH /api/v1/backups/{service_id}/runs/{run_id}/upload
POST /api/v1/backups/{service_id}/runs/{run_id}/complete
GET /api/v1/backups/{service_id}/runs/{run_id}
```

## 18.7. Shares

```text
POST   /api/v1/shares
GET    /api/v1/shares
PATCH  /api/v1/shares/{id}
DELETE /api/v1/shares/{id}
GET    /s/{token}
POST   /s/{token}/unlock
GET    /s/{token}/content
```

## 18.8. Laboratory

```text
POST /api/v1/laboratory/assets
GET  /api/v1/laboratory/assets/{id}
PATCH /api/v1/laboratory/assets/{id}
GET  /a/{asset_id}/{filename}
```

## 18.9. Sync

```text
ANY /dav/*
```

Phase 2:

```text
GET  /api/v1/sync/changes
POST /api/v1/sync/ack
POST /api/v1/sync/moves
POST /api/v1/sync/conflicts/{id}/resolve
```

---

# 19. Авторизация и сессии

## 19.1. Полный web-доступ

Предпочтительно:

- passkey/WebAuthn как основной фактор;
- TOTP или recovery codes как резерв;
- пароль — только при необходимости.

Если используется пароль:

- Argon2id;
- без искусственных ограничений на символы;
- rate limiting;
- MFA;
- re-authentication перед purge, KeePass download, secret rotation.

## 19.2. Cookies

Session cookie:

- Secure;
- HttpOnly;
- SameSite=Lax или Strict;
- короткий idle timeout;
- rotation после login/re-auth;
- server-side invalidation.

## 19.3. CSRF

Все state-changing browser requests защищаются CSRF token или строгой same-origin моделью. WebDAV и service API используют токены в Authorization header и не полагаются на browser cookies.

---

# 20. Безопасность загрузок

## 20.1. Принцип хранения любых типов

Так как это личный архив, система может разрешать большинство расширений, но обязана отделить **хранение** от **исполнения и preview**.

Файл можно сохранить, но не обязательно безопасно открыть на сервере.

## 20.2. Проверки

- лимит размера;
- лимит batch;
- filename normalization;
- запрет traversal;
- определение MIME по содержимому;
- не доверять browser `Content-Type`;
- вычисление hash;
- хранение вне webroot;
- optional antivirus;
- preview только allowlisted форматов;
- архивы не распаковывать автоматически без лимитов на число файлов и объём.

## 20.3. Quarantine

Подозрительный файл:

- сохраняется;
- получает `QUARANTINED`;
- не доступен через Laboratory/share/preview;
- может быть скачан владельцем после предупреждения или удалён.

---

# 21. Защита от исчезновения файлов

## 21.1. Уровни защиты

```text
1. Temp upload + checksum
2. App-level versions
3. Soft-delete trash
4. Storage Box automatic snapshots
5. Metadata backups
6. Независимая вторая копия критичных данных
7. Exit test
```

## 21.2. Политики по умолчанию

| Категория | Версии | Корзина |
|---|---|---|
| General files | 10 версий или 30 дней | 90 дней |
| Mastermind Markdown | 100 версий или 30 дней | 90 дней |
| Mastermind attachments | 10 версий или 30 дней | 90 дней |
| KeePass | 50 версий или 90 дней | без auto purge до ручного решения |
| Laboratory public assets | immutable versions | 90 дней |
| Service backups | собственная retention | не через общую корзину |

## 21.3. Snapshots

Включить ежедневные automatic snapshots Storage Box и при возможности недельные/месячные точки. Snapshots помогают при массовой ошибке Gateway или ransomware через sync, но находятся на том же Storage Box и не являются независимым backup.

## 21.4. Вторая копия

Минимальный вариант:

- KeePass;
- Mastermind;
- metadata exports;
- критические документы;

периодически копируются на локальный зашифрованный HDD или во второе облако.

---

# 22. Backup самой системы Gateway

## 22.1. Что резервировать

- PostgreSQL;
- конфигурацию без plaintext secrets;
- encrypted secret bundle;
- audit export;
- список active shares без открытых tokens;
- deployment manifests;
- миграции БД.

## 22.2. Расписание

- `pg_dump` каждые 6 часов;
- nightly full backup;
- daily metadata JSONL export;
- weekly restore test;
- VPS snapshot/backup по возможностям провайдера.

## 22.3. Куда сохранять

Первая копия — Storage Box в `/backups/gateway`.  
Вторая копия — независимый provider или локальный encrypted storage.

## 22.4. Recovery order

1. Развернуть чистый Gateway.
2. Подключить StorageAdapter.
3. Восстановить PostgreSQL.
4. Запустить migrations.
5. Выполнить reconciliation dry-run.
6. Проверить KeePass, Mastermind, shares и Laboratory assets.
7. Переключить DNS.

## 22.5. Целевые RPO/RTO

| Объект | Цель | Комментарий |
|---|---|---|
| Завершённые файлы | RPO близко к 0 | После ответа `upload complete` файл и hash уже зафиксированы на Storage Box |
| Metadata MVP | RPO до 6 часов | Определяется частотой `pg_dump`; для более строгой цели добавить WAL-архивацию |
| Metadata после hardening | RPO до 15 минут | WAL/частые incremental backups во второе место |
| Gateway access | RTO до 4 часов | Чистый redeploy, DB restore, reconciliation, DNS |
| Отдельный Share | RTO до 4 часов | Записи восстанавливаются вместе с БД; открытые tokens не экспортируются в plaintext |

Эти значения являются целевыми, а не гарантией Hetzner. Они должны быть подтверждены restore drill.

---

# 23. Наблюдаемость

## 23.1. Audit log

Фиксировать:

- login/logout/re-auth;
- создание и погашение Drop-кода;
- upload/download;
- move/rename/delete/restore;
- version restore;
- создание/revoke Share;
- Laboratory asset access;
- backup run;
- token creation/revoke;
- security settings changes.

Не логировать:

- plaintext passwords;
- Drop code;
- share token полностью;
- service token;
- KeePass contents;
- Authorization headers.

## 23.2. Метрики

- Storage Box used/free;
- SFTP active/queued connections;
- upload/download throughput;
- incomplete uploads;
- backup freshness;
- failed checksums;
- reconciliation anomalies;
- active shares;
- Drop brute-force attempts;
- PostgreSQL health;
- worker queue depth.

## 23.3. Alerts через Telegram

- backup не поступил в ожидаемое окно;
- место >80% и >90%;
- checksum mismatch;
- mass delete/move;
- много неудачных Drop attempts;
- Storage Box недоступен;
- metadata backup устарел;
- reconciliation обнаружил missing files.

---

# 24. Производительность и ограничения

## 24.1. Gateway как data proxy

Все uploads/downloads идут через Gateway, поэтому его канал является частью data path. Это сознательное решение ради единой точки безопасности и логики.

## 24.2. Диск Gateway

Gateway не должен хранить основной архив. Локальный диск нужен для:

- PostgreSQL;
- logs;
- небольшого cache;
- временных preview;
- аварийного spool при кратком отказе Storage Box.

Большие `.part` по умолчанию пишутся прямо на Storage Box.

## 24.3. RAM

Потоковая передача использует bounded buffers, например 1–8 MB на соединение. Запрещено `readAll()` для больших файлов.

## 24.4. Ограничение SFTP

Учитывая лимит одновременных соединений Storage Box:

- pool обязателен;
- background jobs имеют низкий priority;
- folder ZIP ограничивает параллелизм;
- sync client использует batching;
- retry применяет exponential backoff + jitter.

## 24.5. Большие файлы

- resumable upload;
- Range download;
- checksums во время потока;
- idempotency key;
- максимальный размер конфигурируемый;
- timeout зависит от активности, а не общей длительности.

---

# 25. Основные угрозы и меры

| Угроза | Последствие | Мера |
|---|---|---|
| Перебор Drop-кода | чужой upload | короткий абсолютный TTL, rate limit, Telegram alert |
| Кража Drop-кода | upload мусора | upload-only, batch quota, no list/read/delete |
| Path traversal | запись вне `drop point` | canonical path + server-generated destination |
| Вредоносный файл | exploit preview | store outside webroot, sandbox/allowlist preview |
| Огромный upload | исчерпание storage/channel | size, daily quota, concurrency limits |
| Утечка share token | доступ к файлу | 128-bit token, expiry, password, revoke, logs |
| Утечка service token | фальшивые backups | scoped token, quota, rotation, optional mTLS |
| Ransomware через sync | массовая порча | app versions, trash, snapshots, mass-change alert |
| Сбой Gateway во время upload | `.part`/несогласованность | resumable state machine + reconciliation |
| Потеря PostgreSQL | потеря metadata/shares | частые dumps, JSONL exports, restore test |
| Компрометация Gateway | доступ к Storage Box | sub-account, least privilege, second copy, secret rotation |
| Компрометация Storage Box password | direct access | random offline password, external reachability off |
| Telegram spoof | выдача кода чужому | allowlist user ID, webhook secret, update dedupe |
| Ошибка массового delete | потеря архива | soft delete, delayed purge, snapshots |
| «View-only» обход | получатель сохраняет файл | честно обозначить ограничение; watermark позже |
| Provider lock-in | сложный переезд | standard paths, StorageAdapter, rclone, manifests, exit test |

---

# 26. Подводные камни

## 26.1. Storage Box — один host с RAID, а не независимая вторая копия

RAID защищает от отказа дисков, но не заменяет отдельный backup. Критичные данные должны иметь ещё одну копию.

## 26.2. Snapshots расходуют место

При изменении или удалении больших файлов snapshot сохраняет старое содержимое, поэтому место может расти быстро. Нужны метрики и прогноз.

## 26.3. Нет storage events

Storage Box не отправляет S3-like события. Поэтому metadata обновляется через Gateway и периодически проверяется reconciliation.

## 26.4. WebDAV interoperability

Разные клиенты по-разному используют LOCK, ETag, MOVE и timestamps. Нужны compatibility tests с реальными Windows/macOS/rclone клиентами.

## 26.5. Move detection при универсальном sync

Некоторые клиенты представляют move как delete + upload. Стабильный resource ID может потеряться. Решения:

- hash-based relink;
- собственный Sync Agent;
- короткое окно сопоставления delete/create;
- ручное восстановление сопоставления ресурса.

## 26.6. KeePass concurrency

Обычный file overwrite может потерять изменения. Нужны version checks, ETag и встроенная KeePass synchronization.

## 26.7. Folder share ZIP

Потоковый ZIP нельзя нормально возобновить и заранее узнать Content-Length. Для больших папок нужен предварительно подготовленный package.

## 26.8. Gateway — единая точка отказа доступа

Файлы остаются на Storage Box, но web/sync/sharing временно недоступны. Решения:

- простой автоматический redeploy;
- VPS snapshot;
- documented break-glass;
- health alerts;
- восстановление в течение нескольких часов.

## 26.9. Все байты проходят через VPS

VPS должен иметь достаточный трафик и скорость. Для редкого sharing это приемлемо. Для массового Laboratory traffic потребуется cache/CDN.

## 26.10. Короткий код не равен доверенному устройству

Одноразовость ограничивает последствия, но не предотвращает перехват самого файла локальным malware. На чужом устройстве не следует загружать секреты, которые уже раскрыты этому устройству.

## 26.11. Возобновление upload через SFTP нужно проверить экспериментально

Архитектура предполагает запись частей в `.part` по offset. До основной разработки необходимо проверить конкретную SFTP-библиотеку и Storage Box на:

- корректный `seek`/`WriteAt`;
- продолжение после reconnect;
- безопасный rename временного файла;
- поведение при повторной записи последнего chunk.

Fallback, если random writes окажутся нестабильными:

1. временно spool-ить активный upload на локальный диск Gateway; либо
2. сохранять chunks отдельно на Storage Box и после завершения последовательно собирать final file через Gateway.

Второй fallback удваивает внутренний трафик и должен использоваться только при необходимости.

---

# 27. Развертывание

## 27.1. Инфраструктура

Минимально:

- 1 VPS с публичным IPv4/IPv6;
- 2 vCPU;
- 2–4 GB RAM;
- 30–60 GB SSD;
- домен;
- Storage Box;
- отдельная резервная копия критичных данных.

## 27.2. Размещение

Предпочтительно Gateway и Storage Box в инфраструктуре Hetzner, чтобы:

- отключить External Reachability;
- уменьшить latency;
- не выводить storage transport в открытый интернет.

Однако StorageAdapter должен поддерживать работу и при другом VPS.

## 27.3. Docker Compose

```text
compose
├── reverse-proxy
├── gateway-api
├── gateway-worker
├── postgres
└── optional-clamav
```

Telegram может быть модулем `gateway-api`; отдельный контейнер не обязателен.

## 27.4. Secrets

- не включать в Git;
- не помещать в frontend build;
- использовать Docker secrets, systemd credentials или root-readable files;
- отдельные keys/tokens для production;
- rotation runbook.

## 27.5. Обновление

1. Backup DB.
2. Deploy новой версии в staging/secondary port.
3. Run migrations.
4. Health check.
5. Переключить reverse proxy.
6. Сохранить предыдущий image для rollback.

---

# 28. Тестирование

## 28.1. Unit tests

- path normalization;
- permission scopes;
- Drop code lifecycle;
- Share expiry/password;
- retention calculations;
- state machines;
- Range parsing;
- token hashing.

## 28.2. Integration tests

- локальный SFTP test server;
- PostgreSQL;
- upload/rename/delete/restore;
- SFTP disconnect на середине операции;
- retry и idempotency;
- WebDAV clients;
- Telegram webhook signature header.

## 28.3. End-to-end tests

1. Получить Drop code в Telegram.
2. Погасить код.
3. Загрузить файл с обрывом и продолжить.
4. Увидеть файл в Drop Point.
5. Переместить и связать с двумя субъектами.
6. Создать password-protected share.
7. Скачать Range chunks.
8. Вставить asset в Laboratory.
9. Переименовать файл — ссылка Laboratory продолжает работать.
10. Синхронизировать Mastermind и создать conflict.
11. Загрузить service backup и выполнить restore test.

## 28.4. Failure injection

- Storage Box timeout;
- PostgreSQL unavailable после rename;
- Gateway restart во время upload;
- disk full;
- checksum mismatch;
- duplicate complete request;
- expired Drop code;
- revoked Share во время Range requests;
- массовый delete от sync client.

## 28.5. Security tests

- traversal variants;
- forged MIME;
- oversized archive;
- brute-force Drop;
- CSRF;
- token replay;
- share enumeration;
- service token privilege escalation.

## 28.6. Exit test

Не реже раза в квартал:

1. выгрузить test directory через независимый tool;
2. импортировать его в альтернативный backend;
3. восстановить metadata export;
4. переключить тестовый StorageAdapter;
5. проверить hashes и links.

---

# 29. План реализации

## Этап 0. Проверка предпосылок

- создать Storage Box и Gateway sub-account;
- отключить лишние протоколы;
- проверить External Reachability;
- измерить upload/download через SFTP;
- проверить Range seek;
- проверить лимит соединений;
- зафиксировать maximum file size.

**Checkpoint:** загрузка и скачивание 20–50 GB файла потоково без полной локальной копии.

## Этап 1. Ядро хранения

- PostgreSQL schema;
- StorageAdapter;
- files/folders API;
- upload state machine;
- checksum;
- soft delete;
- versions;
- audit;
- minimal Files UI.

**Checkpoint:** обычный файловый менеджер работает; отказ в середине upload не создаёт видимый повреждённый файл.

## Этап 2. Drop Point и Telegram

- bot webhook;
- `/drop` и `/revoke`;
- code lifecycle;
- upload-only sessions;
- Drop Point;
- alerts.

**Checkpoint:** чужое устройство может только загрузить batch и не видит архив.

## Этап 3. Sharing

- share records;
- expiry/password;
- Range streaming;
- folder browse;
- packages;
- logs.

**Checkpoint:** ссылка продолжает работать после physical move, но перестаёт после revoke.

## Этап 4. Mastermind и KeePass

- scoped device tokens;
- WebDAV Gateway;
- conflict policy;
- отдельные security rules KeePass;
- version retention.

**Checkpoint:** Mastermind синхронизируется между ПК и Gateway; конфликт не перезаписывает файл.

## Этап 5. Backups

- service registry;
- upload protocol;
- retention;
- encrypted backup support;
- dashboard;
- restore tests.

**Checkpoint:** compromised service token не читает и не удаляет старые backups.

## Этап 6. Laboratory

- asset model;
- stable URLs;
- Markdown fragment;
- public/private modes;
- caching/Range.

**Checkpoint:** статья подгружает большой файл, а перемещение файла не ломает ссылку.

## Этап 7. Hardening и disaster recovery

- automatic snapshots;
- second copy;
- alerts;
- reconciliation;
- recovery runbook;
- exit test;
- нагрузочное и security testing.

**Checkpoint:** чистый Gateway восстанавливается по документации; hashes совпадают.

---

# 30. Критерии приёмки

Система считается готовой к личному production, если выполнены условия:

1. Storage Box credentials отсутствуют в browser, PC clients, Laboratory и внутренних сервисах.
2. При выключенной External Reachability Gateway продолжает работать из Hetzner network.
3. Upload 20 GB можно возобновить после обрыва.
4. Неполный upload не появляется в Files.
5. Удалённый файл восстанавливается из trash.
6. Перезаписанный KeePass восстанавливается из версии.
7. Drop code допускает несколько устройств до общей абсолютной границы 30 минут от выпуска и не даёт list/read/delete.
8. Telegram bot выдаёт код только разрешённому user ID.
9. Backup producer видит только собственный upload API.
10. Mastermind хранится целиком и может быть открыт как обычная Obsidian folder после выгрузки.
11. Share поддерживает expiry, password и revoke.
12. File download поддерживает Range и resume.
13. Laboratory asset link не зависит от physical path.
14. Перемещение файла не ломает active links.
15. WebDAV/device token ограничен разрешёнными каталогами.
16. Массовое удаление создаёт alert и остаётся обратимым.
17. PostgreSQL восстанавливается из backup.
18. Metadata экспортируется в открытый JSONL.
19. Тестовый переезд на другой backend выполнен и задокументирован.

---

# 31. Предлагаемые значения конфигурации первой версии

```yaml
uploads:
  max_file_size: 20GiB
  max_drop_batch: 20GiB
  incomplete_ttl: 24h
  checksum: sha256
  resumable: true

storage:
  max_sftp_connections: 8
  operation_timeout: 60s
  retry_max: 5
  retry_backoff: exponential_jitter

trash:
  default_retention: 90d

versions:
  general: 10_or_30d
  mastermind_markdown: 100_or_30d
  mastermind_attachments: 10_or_30d
  keepass: 50_or_90d

share:
  default_expiry: 7d
  token_entropy: 128bit
  password_hash: argon2id

quick_drop:
  code_length: 8
  code_ttl: 5m
  session_ttl: 15m
  max_attempts_per_ip: 5_per_15m
  max_files: 20
  permissions: upload_only

backups:
  daily: 7
  weekly: 4
  monthly: 12
  restore_test: monthly

reconciliation:
  metadata_scan: daily
  sample_hash_scrub: weekly
  full_hash_scrub: before_migration
```

Значения являются стартовыми и должны изменяться конфигурацией, а не правкой кода.

---

# 32. Решения, которые необходимо подтвердить перед разработкой

1. Домен Gateway.
2. Размещается ли VPS в Hetzner network.
3. Максимальный размер одного файла и batch.
4. Нужен ли публичный Laboratory traffic или только частный.
5. Какие каталоги синхронизируются двусторонне.
6. Какие `.obsidian` файлы исключать из sync.
7. Имя и расположение KeePass database.
8. Список внутренних сервисов и размеры backups.
9. Нужен ли mTLS сразу или достаточно scoped tokens.
10. Срок корзины и число версий.
11. Нужен ли пароль для всех shares по умолчанию.
12. Куда уходит независимая вторая копия.
13. Допустимый RPO/RTO Gateway metadata.
14. Нужна ли antivirus-проверка первой версии.
15. Нужен ли собственный desktop agent после WebDAV MVP.

До ответа используются proposed defaults из раздела 31.

---

# 33. Итоговое заключение

Предлагаемая система остаётся сравнительно небольшой: один VPS, один Storage Box и одна PostgreSQL. Её сложность возникает не из количества сервисов, а из необходимости аккуратно реализовать состояния файловых операций, безопасность одноразового доступа, versions/trash, синхронизацию и provider-independent metadata.

Для заданного сценария Storage Box подходит как backend, потому что:

- хранит обычные каталоги и файлы;
- доступен через стандартный SFTP;
- пригоден для backups и больших файлов;
- позволяет в аварийной ситуации забрать данные без фирменного приложения;
- не навязывает собственный web UI.

При этом нельзя считать его единственной гарантией сохранности: app-level versions, trash, snapshots, metadata exports и независимая копия критичных данных обязательны.

Главное архитектурное свойство решения — **всё внешнее взаимодействие принадлежит Gateway, но сами данные остаются обычными переносимыми файлами**. Это обеспечивает одновременно удобство, контроль доступа и возможность выйти от провайдера без повторения ситуации с закрытым облачным диском.

---

# 34. Официальные источники и стандарты

1. [Hetzner Docs — Storage Box Overview](https://docs.hetzner.com/storage/storage-box/general/): поддерживаемые протоколы, sub-accounts, RAID/checksums, лимиты соединений.
2. [Hetzner Docs — Creating a Storage Box](https://docs.hetzner.com/storage/storage-box/getting-started/creating-a-storage-box/): External Reachability, SSH key, отключение лишних протоколов.
3. [Hetzner Docs — SFTP/SCP](https://docs.hetzner.com/storage/storage-box/access/access-sftp-scp/) и [SSH/rsync/BorgBackup](https://docs.hetzner.com/storage/storage-box/access/access-ssh-rsync-borg/).
4. [Hetzner Docs — Storage Box Snapshots](https://docs.hetzner.com/storage/storage-box/snapshots/): свойства, расход места и ограничение «не является полным backup».
5. [Obsidian Help — How Obsidian stores data](https://obsidian.md/help/data-storage): vault как папка с Markdown-файлами и подпапками.
6. [KeePass Help — Security](https://keepass.info/help/base/security.html): шифрование всей database.
7. [KeePass Help — Synchronization](https://keepass.info/help/v2/sync.html): синхронизация с file/URL и обработка конкурентных изменений.
8. [Telegram Bot API](https://core.telegram.org/bots/api): webhook, update ID, user ID и webhook secret token.
9. [tus — resumable file uploads](https://tus.io/) и [tus protocol](https://tus.io/protocols/resumable-upload).
10. [RFC 4918 — WebDAV](https://datatracker.ietf.org/doc/html/rfc4918).
11. [RFC 9110 — HTTP Semantics](https://datatracker.ietf.org/doc/html/rfc9110), раздел Range Requests.
12. [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
13. [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
14. [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
