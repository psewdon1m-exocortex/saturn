# Neptune: ограниченный поиск native identity при восстановлении membership

2026-10-18, кампания `1baef8fd-b990-4306-9f34-f2789b0509a6`.

Восстановление после внешнего hardlink на источнике500000 файлов продвигалось примерно на60 каталогов/4920entries за9min. Stack PID20244 показал `StageParentEntries → SQLite`. При проверке каждой native записи запрос соединял все `local_cycle_files` текущего scope с incarnations и фильтровал `COALESCE(i.native_id,f.node_id)`. Такой же поиск выполнялся при импорте parent plan.

Проверка до исправления: оба варианта проекции на10000rows давали более3млн SQLite VM операций для20 поисков; адресные complexity tests упали2/2. Семантические сравнения проходили.

В `NeptuneStateStore.ParentNativeLookup.cs` запрос разделён на два индексированных поиска: logical/native key без incarnation и native incarnation с последующим поиском logical key. Они используют существующие primary/unique indexes. `CROSS JOIN` фиксирует порядок второго поиска без зависимости от `ANALYZE`. Старый native ID заменённого файла больше не совпадает, same-ID incarnation не дублируется. Миграция и изменение схемы не нужны. Используют helper `StageParentEntries` и `ImportParentPlan`; сохраняются проверки пути, incarnation, типа и baseline.

После исправления: **13 PASS, 0 FAIL, 0 SKIP** —2complexity/semantic cases и11 связанных native parent/atomic-save/rename/recovery/negative cases. Рабочие binaries не перезаписывались; новая сборка в `bin/neptune-parent-native-index-repair`.

Readonly сравнение на настоящей retained базе500k: обе версии возвращают идентичные строки для существующей и отсутствующей identity. До:7582500VMопераций,254–269ms на lookup. После:<100VMопераций (счётчик с шагом100),0.06–0.08ms. Это одно измерение конкретного SQL, не коэффициент ускорения всей синхронизации.

Evidence: `.audit/2026-10-18/endurance-6h/supplemental/neptune-parent-native-index-repair/` — before/after TRX, live-query-comparison.json, hashes.json, согласованный `main-before-restart.db`, digest45290 retained originals. Native8 прерван контролируемо в05:20:15UTC после PASS гейтов; его exit1 не является новым дефектом продукта. Native9 запущен05:20:19UTC на том же корпусе, профиле, scope и parent plan. Полный readback500k ещё ожидается.
