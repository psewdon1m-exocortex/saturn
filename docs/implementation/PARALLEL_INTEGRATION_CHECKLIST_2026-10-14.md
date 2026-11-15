# Общий integration checklist C01–C23

Владелец: CHAT-A. 2026-10-14. Код не запускался. `CODE` означает наличие серверной реализации/production wiring по статическому чтению, **не PASS**. `REPORTED` — сведения собственного status-файла другого владельца; CHAT-A его код не изменяет и не квалифицирует.

Контракты: **K1 r2 / K2 r2 / K3 r2 / K4 r1**. CHAT-C принял K1 r2 в статусе 17:00, сообщил подключение metadata batch и завершение собственного кода без validation. CHAT-B в статусе 17:05 принял K1 r2; CHAT-A прочитал `ApproveDeletePlanAsync` и durable approval gating в Neptune. Запрос server registration закрыт на уровне source integration, runtime gate открыт. Точные формы — [contracts](PARALLEL_SYNC_CONTRACTS_2026-10-14.md), серверный [handoff](CHAT_A_IMPLEMENTATION_HANDOFF_2026-10-14.md), статусы [A](parallel-2026-10-14/CHAT-A.md), [B](parallel-2026-10-14/CHAT-B.md), [C](parallel-2026-10-14/CHAT-C.md).

| C-ID | CHAT-A Saturn | CHAT-B Neptune / CHAT-C Pluto-host | Открытый gate |
|---|---|---|---|
| C01 | — | B REPORTED diagnostics; причина задержки OPEN | Разрешённая dynamic diagnosis |
| C02 | K3 API CODE | C REPORTED daemon indexed session | Daemon lifecycle |
| C03 | — | C REPORTED inotify/durable reconciliation | Linux restart/gap |
| C04 | — | B REPORTED volume subscription/dirty debounce | Windows identity/gap |
| C05 | CODE long-poll | B/C REPORTED callers | Cursor/timeout/reconnect |
| C06 | CODE folder batch | B/C REPORTED cache/batch | Refs/replay/bounds |
| C07 | CODE + явная unsupported writer matrix | B/C используют guarded API | All-writer acceptance |
| C08 | CODE durable owner/queue/read slots/handoff | — | Real SFTP drain/crash/fence |
| C09 | CODE MOVE/case-only primitive | B REPORTED stable-ID planner | Windows rename conflicts |
| C10 | CODE quarantine/restore/approval | B REPORTED preview/approval; K1 r2 server registration прочитан | Approval/CAS/ACK runtime |
| C11 | CODE versioned policy/binding transition | B/C REPORTED preview/state | Scope change retains copies |
| C12 | CODE codec/vectors/readonly plan/adopt | B/C REPORTED codecs; server artifact опубликован | Collision/migration compatibility |
| C13 | CODE existing batch HTTP compatibility/gzip/retry | B/C REPORTED ordinary batches | Missing-only/resume |
| C14 | CODE empty/meta/batch | B/C REPORTED callers | Metadata proof/no data retransmit |
| C15 | CODE early stream/ACK/seal/old CAS | B/C REPORTED source/transport | Restart/source mutation/UNKNOWN |
| C16 | CODE shared admission/fairness/retry hints | B/C REPORTED retry controllers | Resource ceilings/fairness |
| C17 | CODE bounded gzip metadata | B/C REPORTED codecs | CPU/decoded limits |
| C18 | CODE operational CLI/adoption/repair/rollback | B/C REPORTED profile CLI/state; receipt handoff published | Real old/new upgrades |
| C19 | — | B REPORTED portable/MSI lifecycle | Native signed packages/install |
| C20 | CODE root/backend metrics + engine check-in | B/C REPORTED status/diagnostics; C omission снят | Redaction/meaningful timings |
| C21 | CODE authorized lookup/clone | B/C REPORTED callers | Independent physical copy/CAS |
| C22 | CODE client/registry/local verifier/package wiring | C REPORTED Linux host; objects agreement принят | External install/qualification |
| C23 | CODE cooperative scrub/availability journal | — | Deadline/pressure/corruption |

0057–0061 и старые sealed originals сохранены; новые миграции 0062–0066 не применялись. Workspace payload не собирался. Source fingerprints показывают, что CHAT-A не изменял существующие test files. Neighbour status может измениться после этого snapshot; подтверждённый end-to-end результат должен ссылаться на одну согласованную версию всех компонентов.

Следующий этап после разрешения: affected contract/state/build/migration checks → API/storage/client integration/native gates → один согласованный regression pass. Install/deploy/verifier host и 6h требуют отдельного допуска. O01–O03 не реализованы и не добавлены в обязательный объём.
