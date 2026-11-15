# Guarded read admission — 18 октября 2026

При непрерывных записях в общий sync root новый Neptune-клиент исчерпал 150 попыток начального чтения. Snapshot и feed HTTP-обработчики обходили существующую очередь публичных записей и могли снова попадать на незавершённую публикацию. Это воспроизведено на отдельной PostgreSQL fixture с реальной физической публикацией, задержанной перед rename.

## Изменение

`GuardedRuntimeScope` передаёт HTTP-слою тот же `CatalogRootAdmission`, который используют FileService и namespace mutations. Snapshot start/step/ready, entries/changes и каждое SQL-наблюдение long-poll проходят через эту ограниченную FIFO-очередь.

Авторизация и binding проверяются до ожидания и повторно после получения слота. Замена runtime scope/очереди во время ожидания закрывает запрос. Отключение ожидающего клиента удаляет его из очереди. Ожидание long-poll между запросами SQL и отправка HTTP-ответа не занимают слот.

SQL остаётся окончательным арбитром: чужая операция из другого процесса и UNKNOWN outcome по-прежнему дают `409 reconciliation_required`. Очередь не изменяет originals, baseline, fencing, readiness или receipts. Ограничения вместимости/времени ожидания сохраняются.

## Адресные проверки

- Пять реальных публикаций с barrier перед rename: snapshot start/step/ready, entries, changes. До исправления 5 FAIL — читатель обходил очередь; после 5 PASS, все исходные публикации завершены PUBLISHED.
- Два отрицательных случая: другая public claim и UNKNOWN. Оба возвращают 409, original row до/после полностью совпадает. Первый запуск этих двух тестов содержал ошибку fixture: передача privately qualified handle другому coordinator. Fixture открывает тот же durable original через свой coordinator; продуктовая проверка authority сохранена.
- Шесть случаев очереди: отзыв авторизации, смена binding, смена runtime, overflow/retry, long-poll без удержания слота, отключение ожидающего HTTP-клиента. Вместе с связанными HTTP-проверками: 35 PASS.
- Typecheck пакета sync и приложения API: PASS. Одна старая fixture composition получила новое обязательное поле.

Evidence: `C:/.projects/exocortex/.audit/2026-10-18/endurance-6h/supplemental/read-admission-*`.

## Граница доказательства

Долгоживущий основной SFTP/SQL fixture текущего 500000-файлового прогона продолжает работать на загруженном старом серверном коде. Его нельзя перезапустить обычным fixture runner: тот создаёт новые bindings. Исправление проверено отдельно; полный повтор исходного native-клиента под непрерывной записью на обновлённом сервере пока не выполнен. Это не утверждение о закрытии всех причин starvation или о росте общей скорости большого прогона.

Миграция для этой правки не требуется. Additive migration 0069 относится к отдельному исправлению SQL clone-admission и описана в `ENDURANCE_2026-10-18_CLONE_ADMISSION_REPAIR.md`.
