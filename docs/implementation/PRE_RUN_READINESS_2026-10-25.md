# Подготовка кандидата к общему прогону, 25 октября 2026

Основной отчёт и точные доказательства: [REPORT](../../../.audit/2026-10-25/pre-run-solo01/REPORT.md). Путь относительно репозитория Saturn находится уровнем выше: `C:/.projects/exocortex/.audit/2026-10-25/pre-run-solo01/REPORT.md`.

Кандидат сохранён в `C:/ra25/preflight01`, manifest — `C:/.projects/exocortex/.audit/2026-10-25/pre-run-solo01/CANDIDATE_MANIFEST.json`. Full6h/500k не запускался, production не изменялся, коммитов нет.

Подтверждены actual release Saturn0.2.13→current DB upgrade47→109,62applied/repeat0, оригинальный pending upload и все161версии/SHA, реальный pg_dump/restore,20отдельных native Pluto jobs/2560SHA, полный Windows service через Kernel/Saturn в legacy DAV, guarded handler-level native проверки, Drop34 и новые aggregates mismatch0. Исправлен install.sh: старые API/worker должны быть остановлены до migrate, ошибки stop/migrate прекращают установку.

Нельзя автоматически активировать guarded root одним обновлением SQL, смешивать разные поколения Drop writers или считать helper/SQL tests полной nativeUI/MSI приёмкой. Перед большим прогоном остаются explicit full-API fast-root qualification, supported mixed-version matrix, native UI/signed payload и квалифицированный C-only бюджет. Исторические невоспроизведённые T01/B2 сохранены как UNKNOWN risk без бесконечных повторов.

Точный порядок и условия допуска: `C:/.projects/exocortex/.audit/2026-10-25/pre-run-solo01/OPERATOR_RUNBOOK.md`, `MIGRATION_AND_COMPATIBILITY.md`, `joint-gates.json`.40групп coverage имеют частичное адресное доказательство; это не40полных PASS. Production release GO не выдан.
