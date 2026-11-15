# CHAT-A — Saturn

Время: 2026-10-14T15:55:00+03:00. Статус: IN_PROGRESS.

- Completed: входной inventory/hashes; K1/K3/K4 r1 READY (interface only), K2 r1 DRAFT.
- In progress: C07/C08 общий durable mutation/backend executor; C05/C06/C17 HTTP; C22 verifier schema/client/local adapter.
- Open: серверные C11–C16/C18/C20/C21/C23, общая integration. Runtime qualification всего нового кода остаётся OPEN.
- Changed paths: PARALLEL_SYNC_CONTRACTS_2026-10-14.md, этот файл, .history/2026-10-14-parallel-saturn.md и baseline.
- Revisions: K1 r1, K3 r1, K4 r1. K2 не готов для caller implementation.
- Requests B/C: записать принятые revisions/несовпадения в собственный статус. C: использовать общий storage-verifier.ts, сообщить package dependencies; root manifests меняет A.
- Blockers: внешнее включение verifier требует отдельной установки/qualification; здесь не выполняется. Текущие independent части не заблокированы.
- Tests/builds/typecheck/runtime: НЕ ЗАПУСКАЛИСЬ. Production deployment, установка и 6h не выполнялись.

## 2026-10-14T16:11:11.5222286+03:00 — обновление интеграции

- K1 r1 READY; **K2 r2 READY**, **K3 r2 READY** (точный JSON extensions в contract/type); K4 r1 READY. B/C: новые streaming и capabilities callers используют r2.
- Код IN_PROGRESS:0062 backend queue/read budget,0063 mutations/policy,0064 streaming; HTTP/runtime manifestv3 подключены, остаются lifecycle/scrub/writers/static review.
- **Запрос CHAT-C по K4 host integration:** текущий operations/<operationId>.json допускает только один version/path/hash, но upload executor проверяет temp и preimage под одним operationId. Просьба additive поддержать в этом protected operation record массив objects:[{contentVersionId,relativePath,sizeBytes,sha256}] при общих backend/root/operation/intent identity; прежнюю single-object форму сохранить. Saturn пишет record атомарно в operator-configured shared protected registryDirectory (без shell/SSH assumption). Owner record обновляется только после durable acquire; STOPPED после закрытия соединений. HTTP wire K4 r1 не меняется. Просьба отметить принятие/несовпадения.
- C20 Pluto engine extension принимаю; добавляется server typed check-in schema. Окончательные поля перечислю здесь после чтения Go модели.
- Проверки исполнения: не запускались.

## 2026-10-14T16:13:46.7857730+03:00 — C20/C22 integration update

- Pluto check-in принимает optional engine с текущими Go JSON names: mode,phase,Queued,Captured,Published,Recovered,Failed,oldestPendingMs,gap,waitReason,http:{Requests,MetadataBytes,DataBytes,ResponseBytes},capture:{source_reads,source_hash_bytes,private_verification_reads,private_verification_bytes,transport_hash_reads,transport_hash_bytes,transactions,committed_transactions,rolled_back_transactions},features. CHAT-C может снять compatibility omission engine; поля paths/credentials не принимаются.
- storage-verifier package добавлен в root lockfile/tsconfig paths; workspace glob уже включает его. Build/install не выполнялись.
- K4 protected objects registry request выше остаётся актуальным.

## 2026-10-14T16:27:36.1436607+03:00 — runtime integration

- Server code: K1 mutations/UI owner bridge; K2 streaming; K3 capabilities/long-poll/gzip; K4 registry writer; C23 budgeted scrub подключены (статическая сверка продолжается).
- CHAT-C: protected operation record objects request остаётся необходимым, current host authority.ts всё ещё читает single-object. Saturn manifest v3 verifier теперь требует registryDirectory (explicit protected mounted channel); operation record exact shared identity + objects для temp и preimage. HTTP K4 не меняется.
- Остаток A: lifecycle/adoption/upgrade/recovery, общая codec enforcement, bounded cache/cleanup, writer matrix и финальная сверка.
- Ничего не запускалось; READY контрактов не означает PASS реализации.

## 2026-10-14T17:00:34.0244909+03:00 — K1 r2 READY; adoption / verifier handoff

- **К B/C: K1 r2 READY**, K2 r2 / K3 r2 / K4 r1. Capability revisions.K1 теперь 2; r1 mutation envelopes и receipts не меняются. Причина: в клиенте B bulk approval записывает planId/digest, но без регистрации сервер обязан вернуть approval_stale. Добавлен POST /sync/v1/roots/:rootId/delete-plans/approve: {binding,namespace,plan:{schema:'saturn.delete-plan.v1',planId,planDigest,items:[{nodeId,version}]}} (1–500, unique nodes). Ответ {schema:'saturn.delete-plan-approved.v1',planId,planDigest,itemCount}. Аутентифицированный Windows device с can_delete подтверждает свой UI-reviewed digest; exact items/binding/policy/actor хранятся на сервере. План регистрировать один раз до отправки originals с этим planId, повторять тот же список после потери ACK; Pluto approve запрещён. После изменения ожидаемых версий нужен новый preview/approval. K1 r2 также документирует mutations/batch для независимых metadata items.
- **Запрос B:** принять revisions.K1=2 и добавить durable registration выше к bulk delete до mutation execute. **Запрос C:** принять K1=2 (новый delete endpoint Go не использует). Общие поля K3 не меняются.
- C12/C18 server CLI: scripts/sync-lifecycle.mts migrate-plan/adopt (protected config) фиксирует выбранные codec/policyHash, current epoch/binding/seq, immutable NDJSON tree SHA, collision/invalid-name blockers. Adopt выполняется только offline под exclusive maintenance и подтверждённым STOPPED/fence; весь populated root проверяется, смена policy/codec обновляет binding и guard revision. Результат saturn.sync-adoption.v1 содержит семь полей binding, device_id, backend_identity, qualification_receipt_sha256, namespace:{codec,policyHash}; отдельно создаётся новый runtime manifest, автоматического запуска нет. Неверные имена не переименовываются. Клиенты могут использовать это как reviewed server binding artifact и сверять HTTPS capabilities. Исходные credentials/IDs не заменяются.
- Общие codec vectors: packages/contracts/fixtures/name-codec-v1.json. Portable collision key ASCII-fold; существующая PostgreSQL lower(name) uniqueness может дополнительно отказать некоторым Unicode-парам — не автонормализация.
- K4 objects request **закрыт**: прочитаны authority.ts и CHAT-C 16:31; host принимает exact objects. C20 engine omission закрыт ответом C. Root lockfile/alias и optional Docker storage-verifier target подключены; install/build не запускались.
- Backend queue, namespace/stream runtime, policy admission, scrub и lifecycle реализованы; завершаются статическая сверка, writer matrix и общий integration checklist. Тесты, builds/typecheck, migrations, runtime, install/deployment/6h НЕ ЗАПУСКАЛИСЬ; PASS не заявляется.

## 2026-10-14T17:22:20.3741067+03:00 — итог CHAT-A

- **IMPLEMENTED / UNVALIDATED**: C07/C08/C23 и серверные C05/C06/C09–C18/C20–C22 подключены. Migrations 0062–0066 additive; 0057–0061 сохранены. Старые originals/receipts не переписываются.
- K1 r2 / K2 r2 / K3 r2 / K4 r1. CHAT-C в статусе 17:00 принял K1 r2 и сообщил завершение собственного кода без проверок. От B остаётся подтверждение r2 и server registration approved delete plan; инструкция выше. Server adoption artifact/lifecycle опубликован, прежний запрос B по codec transition имеет конкретный ответ.
- Финальная source-сверка: opt-in exact storage paths в v3 (без trim/NFC rewriting), path bound 4096 UTF-8; legacy normalizer сохранён. PAUSED root может перезапуститься для original recovery. Local adoption проверяет root inode/device, symlink/mount/hardlink boundaries и стабильность witness. CLI включён в существующий scripts typecheck scope, но сам typecheck не запускался.
- Handoff: [CHAT_A_IMPLEMENTATION_HANDOFF_2026-10-14.md](../CHAT_A_IMPLEMENTATION_HANDOFF_2026-10-14.md). Общая матрица C01–C23: [PARALLEL_INTEGRATION_CHECKLIST_2026-10-14.md](../PARALLEL_INTEGRATION_CHECKLIST_2026-10-14.md). Там приведены реальные supported/unsupported writers, роль/grants/qualification, limits, migration/rollback/UNKNOWN и будущие gates.
- Ограничения: recursive/cross-root legacy mutations, automatic guarded history purge и legacy full restore явно unsupported. Retained history не удаляется по возрасту; учитывается disk pressure. Host verifier не установлен. Production capability остаётся под qualification gates.
- Проверки: только чтение/ручная source-сверка и файловые fingerprints. **Tests/lint/build/typecheck/migrations/runtime/container/install/deployment/6h НЕ ЗАПУСКАЛИСЬ.** Neptune/Pluto/host package и B/C status этим исполнителем не изменялись.

### 2026-10-14T17:24:27.6047399+03:00 — закрытие contract handoff

CHAT-B в статусе 17:05 принял K1 r2. Прочитаны Neptune ApproveDeletePlanAsync, сохранение server receipt и gating перед quarantine: запрос A закрыт по исходникам. CHAT-C также принял r2. Client profile/adoption у B ещё IN_PROGRESS по его статусу; это не меняет готовность собственного server artifact/CLI. Последнее уточнение сервера: новые операции при PAUSED получают backend_draining + Retry-After, а accepted originals могут завершиться. Все execution/qualification gates остаются OPEN.

## 2026-10-14T20:38:22.9007192+03:00 — целевые тесты A, промежуточный handoff
- Финальные адресные A-contract/catalog:52 PASS; A-storage:30 PASS (включая native Linux host/K4, SFTP, 2-process admission, mid-file scrub cancel); A13:3 PASS (actual CLI faults/pg_dump/pg_restore); дополнительный A08 native retention process crash queued/effect/DONE:3 PASS. Это не полный PASS A15.
- Исправлены gzip >16KiB, SQL0063 parser/alias и NULL approved-plan bypass, SQL0064 maximumFileBytes, Windows local fsync handle, CLI backup/exclusive-admission/upgrade binding. K1r2/K2r2/K3r2/K4r1 неизменны. После SQL правок qualification manifest должен ссылаться на actual function hashes.
- A15 3 alternating baseline/feature pairs RUNNING в отдельной собственной lane. Automatic batching остаётся OFF; наблюдалась внешняя C нагрузка, отсутствие host isolation будет отражено.
- Получены для A15 B final-transport-policy/B07-wire-examples.json, C C-daemon/pluto-k3-checkin.json и C-host-final/verifier-k4-http.json. Остальные реальные B/C request/response artifacts (metadata batch, stream, codec/adoption; C directory) пока отсутствуют. Нужны raw sanitized envelopes + source/binary hashes, без credentials; результаты mock transports не заменяют wire. Доступные примеры будут приняты own API с явной fixture binding map; original IDs сохраняются.
- Журнал: C:/.projects/exocortex/.history/2026-10-14-targeted-tests-chat-a.md. Evidence run: C:/.projects/exocortex/.audit/2026-10-14/targeted-tests/chat-a/run-193036-141be040.


## 2026-10-14T21:11:21.0725597+03:00 — targeted final: A01–A14 PASS, A15 PARTIAL
- 93 unique selected checks PASS, final FAIL0; API/scripts typecheck PASS. Raw first FAIL/fix/repeats preserved. Native subprocess writer/retention crashes, SQL admission/roles, SFTP drain, Linux K4, CLI pg_dump/restore/adoption, mid-file scrub cancel all exercised.
- A15 three clean alternating pairs2/3/4, 6600 authoritative publications: throughput+8.707%, p95 degradation+715.119%. Gate NOT MET; auto batching OFF. Pair1 excluded due C load with decision recorded before pair2 results; all8800 physical publications preserved in run evidence.
- Partial integration receipt: actual B directory167 + exact replay; C K3 Nest HTTP, K4 parse, actual C catalog original with Go/TS canonical hash and own API publication/replay. Explicit fixture binding/device/backend/parent mapping recorded; operation keys retained. K1r2/K2r2/K3r2/K4r1 unchanged.
- A15 remains OPEN for missing B/C raw metadata-batch/stream/adoption and Cdirectory requests. Own server HTTP mutation/12MiB+17stream cases PASS but do not stand in for unavailable client wire. No full A15/whole-group PASS claim.
- Report: C:/.projects/exocortex/.audit/2026-10-14/targeted-tests/chat-a/run-193036-141be040/REPORT.md; machine-readable results/owned hashes/cleanup and partial integration receipt alongside. Journal: C:/.projects/exocortex/.history/2026-10-14-targeted-tests-chat-a.md. Own4 containers removed after custody checks; no production deployment/release/general regression/endurance.

