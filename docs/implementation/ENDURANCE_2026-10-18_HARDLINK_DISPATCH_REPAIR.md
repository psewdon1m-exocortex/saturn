# Neptune: восстановление membership после hardlink во время публикации

2026-10-18, кампания `1baef8fd-b990-4306-9f34-f2789b0509a6`.

В 04:57:29–32 UTC основной native500k и отдельный native4096 остановились с `HardlinkMembershipUnresolved`. Перед этим изолированные NTFS-тесты создали жёсткие ссылки вне обоих источников. USN-журнал общий для тома, поэтому событие увидели оба клиента.

Неизвестный hardlink нельзя считать внешним по текущему пути: историческое событие может скрывать членство внутри источника. Существующая логика правильно сохраняла неопределённость и запрещала новые публикации. Дефект был в обработке события во время активного `ProcessWork`: journal pump останавливала dispatch и выбрасывала ошибку, не переходя к уже реализованной полной проверке membership. Аналогичное событие между проходами восстанавливалось штатно.

Изменение в `neptune/src/Neptune.Core/WindowsFreshSyncEngine.cs`: прежний dispatcher выделен в `ProcessWorkCore`. Только `CycleNamespaceUncertain` при включённом parent reconciliation переводится в обычный `Observe` после завершения dispatcher, всех workers, batch scheduler и journal task. Успешная проверка снимает только установленный этой journal pump запрет новой работы. Другие ошибки и ограничения не перехватываются. Никакие B, original intents, курсоры, исторические unresolved записи или ownership-проверки не сбрасываются. Hardlink внутри источника и изменяющаяся во время проверки membership продолжают запрещать публикацию.

Новый тест `HardlinkDuringActiveDispatchJoinsWorkersBeforeMembershipRecovery` держит реальный worker до фиксации USN uncertainty. Внешний hardlink должен восстановиться и закончить 32 исходные публикации без лишних копий; внутренний должен остаться защитным отказом. Before: внешний вариант воспроизвёл ошибку продукта; дополнительная проверка внутреннего варианта первоначально ошибочно предполагала существование необязательной таблицы до запуска reconciliation — исправлена только fixture. After: оба новых случая и семь существующих hardlink/full-membership случаев **9 PASS, 0 FAIL, 0 SKIP**.

Evidence: `.audit/2026-10-18/endurance-6h/supplemental/neptune-hardlink-dispatch-repair/`. Здесь before/after TRX, SHA исходников/бинарников и согласованные SQLite backup обоих остановившихся профилей. Основной native-repair-7 FAIL сохранён. В 05:05:04 UTC запущен native-repair-8 на том же профиле/корпусе/root/binding из отдельной frozen сборки. Его полный500k readback ещё не завершён.

Дополнительный read-FIFO сценарий повторён в `supplemental/read-fair-native/attempt-1`: прежний receiver штатно закрылся после ошибки, поэтому повтор использует отдельный новый тестовый root. Старые SQL/SFTP/profile сохранены. Этот повтор не доказывает resume старого supplemental профиля; retained resume проверяет основной native500k.

Абсолютный catalog count в `active-vault` на 05:03:45 UTC: **39789 файлов, 5503 папки включая root, 1825882112 байт**. Replacement-scope work count равен29789 и не включает исходные10000. Оба счётчика являются metadata progress, не заменяют полный SHA readback.
