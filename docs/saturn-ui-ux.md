Saturn — Design Specification
1. Общие параметры фрейма
Канвас: Несколько экранов, расположенных вертикально на общем холсте
Размер каждого экрана: 1919 × 1034 px
Фон всех экранов: #000000 (чёрный)
Overflow: clip на всех блоках
2. Цветовая палитра
Токен	Значение	Использование
Accent / Primary	#00A8FF	Логотип, активный пункт меню, заголовки карточек, прогресс-бар
Background	#000000	Общий фон экрана и сайдбара
Text Primary	#FFFFFF	Основной текст (opacity: 100%)
Text Muted	rgba(255,255,255,0.80)	Вторичный текст, неактивные пункты меню, подписи
Border	rgba(255,255,255,1)	Обводка карточек, таблиц, внешнего контейнера
Active border	#00A8FF	Обводка активного пункта меню
Active indicator	#00A8FF	Вертикальная полоска-маркер активного пункта
Success	#62FF8C	Статус "Service Reachability"
Corner dots	#D9D9D9	Точки в углах карточек (декор)
Progress fill	#00A8FF	Заполненная часть прогресс-бара
Progress track	transparent + border white	Пустая часть прогресс-бара
3. Типографика
Используемые шрифты
Шрифт	Начертание	Использование
Space Grotesk	Bold	Название приложения "saturn" / заголовки страниц
Consolas	Bold	Всё остальное: меню, метрики, таблицы, карточки
Размеры текста
Роль	Шрифт	Размер	Цвет	Прочее
Логотип в сайдбаре	Space Grotesk Bold	42px	#00A8FF	text-align: center, w: 170px
Заголовок страницы (h1)	Space Grotesk Bold	80px	#00A8FF	line-height: normal
Заголовок карточки	Consolas Bold	24px	#00A8FF	line-height: normal
Значение метрики	Consolas Bold	24px	#FFFFFF	line-height: normal
Мегазаголовок (Storage-строка)	Consolas Bold	80px	mixed	#00A8FF + #FFFFFF в одной строке
Пункты меню (активный)	Consolas Bold	14px	#00A8FF	no opacity
Пункты меню (неактивный)	Consolas Bold	14px	#FFFFFF	opacity: 0.80
Номера пунктов меню	Consolas Bold	14px	#FFFFFF	opacity: 0.80
Подписи в таблице (header)	Consolas Bold	14px	#FFFFFF	opacity: 0.80
Строки таблицы	Consolas Bold	14px	#FFFFFF	line-height: normal
Выбранная строка (имя)	Consolas Bold	14px	#00A8FF	—
Описание в карточке	Consolas Bold	14px	#FFFFFF	opacity: 0.80
Заголовок карточки (строка)	Consolas Bold	24px	#00A8FF	—
Поиск / кнопки	Consolas Bold	14px	#FFFFFF	opacity: 0.80
4. Левый сайдбар
Контейнер
Размер: 250 × 1033 px
Позиция: left: 0, top: 0 (внутри экрана)
Фон: #000000 (черный прямоугольник поверх фонового изображения)
Фоновое изображение: растровое, object-cover, 100% × 100% (декоративное — планета Сатурн в туманности)
Логотип / планета
Изображение планеты: 192 × 192 px, left: 31px, top: 6px (объект Сатурн, синий, нарисованный, на прозрачном фоне)
Текст "saturn": Space Grotesk Bold, 42px, #00A8FF, center, w: 170px, h: 76px, left: 125px (центр), top: 175–177px
Навигационные пункты меню
Все пункты: Consolas Bold, 14px, left: 31px

Пункт	top	Цвет текста	Номер	Номер top	Номер left
Dashboard	299px	#00A8FF (активный)	01	299px	209px
Storage	346px	#FFFFFF 80%	02	346px	209px
Drop Point	391px	#FFFFFF 80%	04	391px	209px
Shared	436px	#FFFFFF 80%	05	436px	209px
Trash	481px	#FFFFFF 80%	06	481px	209px
Settings	526px	#FFFFFF 80%	07	526px	209px
Documentation	943px	#FFFFFF 80%	—	—	—
Logout	988px	#FFFFFF 80%	—	—	—
Активный пункт меню (выделение)
Рамка вокруг активного пункта: border 1px solid #00A8FF, 221 × 42 px, left: 18px, top: 285px (для Dashboard)
Вертикальный маркер-полоска: 4 × 22 px, #00A8FF, left: -2px (выходит за левый край), top: 295px (вертикально центрирован по рамке)
Треугольник-стрелка: SVG, 12 × 5.77 px, #00A8FF, left: 0, top: 306px — указывает вправо
Сдвиг рамки и маркера при активации разных пунктов:

Storage активен → рамка top: 332px, маркер top: 342px, стрелка top: 353px
Drop Point активен → рамка top: 377px, маркер top: 385–387px, стрелка top: 396px
5. Основной контентный контейнер
Внешний бордер
Позиция: left: 250px, top: 123px
Размер: 1670 × 978 px
Стиль: border 1px solid #FFFFFF
Вертикальная линия-разделитель
Горизонтальная линия, повёрнутая на -90°, length: 1034px, white, left: 251px — это граница сайдбара
Заголовок страницы
Space Grotesk Bold, 80px, #00A8FF
Позиция: left: 280px, top: 15px
Размер: 783 × 76 px
6. Dashboard — карточки метрик
Каждая карточка: 790 × 166 px, bg: #000000, border: 1px solid #FFFFFF

Расположение 4 малых карточек (2 × 2 сетка)
Карточка	left	top
CPU Usage	280px	151px
RAM Usage	1100px	151px
Disk Usage	280px	347px
Uptime	1100px	347px
Анатомия карточки (CPU Usage как пример)
Номер карточки: Consolas Bold, 14px, #FFFFFF 80%, left: +10px от карточки, top: +10px
Заголовок: Consolas Bold, 24px, #00A8FF, left: +37px, top: +36px (относительно карточки)
Значение: Consolas Bold, 24px, #FFFFFF, left: +37px, top: +89px
Угловые точки (4 шт.): SVG circle r=2, #D9D9D9, группа 2×2 точки в правом верхнем углу карточки, смещение 8px × 8px между ними, отступ 4px от края
Прогресс-бар (под каждой карточкой)
Высота: 9px
Заполненная часть: #00A8FF, ширина: 392px (≈50% от 790px)
Трек: border 1px solid #FFFFFF, ширина: 790px (полная)
Позиция: примыкает снизу к карточке (top карточки + 166px = top прогрессбара)
Карточка	Прогресс-бар top
CPU (top:151)	308px
RAM (top:151)	308px
Disk (top:347)	504px
Широкая карточка Storage
Размер: 1610 × 166 px, left: 280px, top: 543px
Текст в одну строку, 80px: "Storage " #00A8FF + "50.8% — 458.6/988.2 Gb " #FFFFFF
Прогресс-бар: top: 700px, заполнено 799px из 1610px
Содержимое карточек
Карточка	Метрика	Значение
CPU Usage	% / cores	50.4% — cores: 1
RAM Usage	% / GB	50.3% — 1/1.9 Gb
Disk Usage	% / GB	50.1% — 10/19.7 Gb
Uptime	время	Active: 20h 45m 22s
Storage	% / GB	50.8% — 458.6/988.2 Gb
7. Малые карточки Dashboard (нижняя строка)
Тип: "universal card - 1x - title" — 375 × 166 px

Карточка	left	top
Drop point code (06)	280px	739px
Storage Reachability (07)	695px	739px
Анатомия карточки
Фон + рамка: SVG внутри, rect 375 × 166 black + rect 374 × 165 stroke white 80%, x:0.5, y:0.5
Угловые точки: 4 SVG circles в правом верхнем углу: cx 359 и 367, cy 8 и 16 (r=2, fill #D9D9D9, stroke white 80%, r=1.5)
Номер карточки: Consolas Bold, 14px, #FFFFFF 80%, left: 16px, top: 22px
Заголовок: Consolas Bold, 24px, #00A8FF, left: 41px, top: 15px
Горизонтальная разделительная линия: 1px white 80%, y: 55px, ширина 375px
Описание/контент: Consolas Bold, 14px, #FFFFFF 80%, left: 41px, top: 69px, w: 221px, h: 58px
Карточка "Drop point code"
Описание: "This option creating secure code for drop point activating."
Карточка "Storage Reachability"
Содержит блок статуса:
Рамка: border 1px solid #62FF8C, 255 × 50 px, opacity: 80%, left: 58px, top: 83px
Текст: "Service Reachability", Consolas Bold 14px, #62FF8C 80%, left: 70px, top: 102px
Индикатор: 18 × 18 px, #62FF8C, left: 279px, top: 99px
8. Storage — таблица файлов
Хлебные крошки + мета
Путь: Consolas Bold, 14px, #FFFFFF 80%, left: 280px, top: 152px
Строка: root › folder1 › folder2 › folder3 › folder_i_need
Строка: 15 items · 2 selected · 216 MB
Поиск и Upload
Search: border 1px solid #FFFFFF 80%, 527 × 43 px, left: 1217px, top: 150px
Текст "⌕ Search", Consolas Bold, 14px, left: 1231px, top: 164px
Upload here: border 1px solid #FFFFFF 80%, 124 × 43 px, left: 1766px, top: 150px
Текст "Upload here", Consolas Bold, 14px, left: 1785px, top: 164px
Контейнер таблицы
border 1px solid #FFFFFF, 1611 × 782 px, left: 279px, top: 222px
Заголовок таблицы
Consolas Bold, 14px, #FFFFFF 80%, left: 303px, top: 236px
Текст: NAME / MODIFIED / SIZE / SHARED STATUS
Горизонтальная линия-разделитель: 1px white, y: 262px, ширина: 1610px
Иконки сортировки (колонки)
Двойные стрелки (вверх + вниз), SVG 12 × 5.77 px, white
Позиции по x: 343px (NAME), 567px (MODIFIED), 775px (SIZE)
top: 237px для всех
Строки таблицы
Каждая строка: высота 30px + gap ~11px (top: 286, 327, 376, 414...)

Строка выбрана (selected):

Рамка: border 1px solid #00A8FF, 150 × 30px вокруг имени
Имя файла: #00A8FF
Строка невыбрана:

Рамка: border 1px solid #FFFFFF, 150 × 30px
Имя файла: #FFFFFF
Колонки и позиции (relative to таблице):

Колонка	left (абс.)	Ширина
NAME (текст)	320px	128px
MODIFIED	501px	184px
SIZE	738px	184px
SHARED STATUS	1763px	184px
Пример строк:

folder_i_need_1 / 01 Sep 2026, 18:14 / 185.6 MB → selected (синяя рамка)
folder_i_need_1 / 01 Sep 2026, 18:14 / 2 MB → не выбрана
wpfgfx_cor3.dll / 01 Sep 2026, 18:14 / 4 KB / [ Shared ]
v2rayN.exe / 01 Sep 2026, 18:14 / 7 MB → имя #00A8FF
9. Паттерн угловых точек карточек
Повторяется на всех карточках. Две точки по x (offset 8px), две по y (offset 8px):

● ●    ← cy: 8px
● ●    ← cy: 16px
cx: 359, 367
SVG circle: r=2, fill #D9D9D9, обводка white 80%, r=1.5 (на больших карточках — без обводки, только fill)

10. Разметка экранов (вертикальная стопка на холсте)
Экран	top на холсте	Ширина	Высота
Saturn Left Menu (превью)	2205px	250px	1033px
Saturn Dashboard	3402px	1919px	1034px
Saturn Storage	4498px	1919px	1034px
11. Состояния активного пункта меню
Экран	Активный пункт	Цвет пункта
Dashboard	Dashboard (01)	#00A8FF
Storage	Storage (02)	#00A8FF
Drop Point	Drop Point (03)	#00A8FF
Неактивные пункты всегда: #FFFFFF + opacity 80%.

12. Декоративные SVG-элементы
Стрелка-маркер сайдбара
SVG path, 12 × 5.77 px, #00A8FF
Указывает вправо (→), находится на левом краю (left: 0)
Вертикально центрирована по рамке активного пункта (top = рамка.top + 21px)
Прогресс-стрелки в таблице
Те же SVG 12 × 5.77 px, белые, повёрнуты на ±90° (sort ascending / descending)
Расположены парами рядом с заголовками колонок
Этого документа достаточно, чтобы воссоздать интерфейс Saturn с нуля без визуального макета.

привет, ты модешь разобрать этот фрейм по проекту saturn по косточкам? мне нужны точные отступы, расположение, цвета, шрифты, все размеры и другие показатели. нужно из этого сформировать такой документ, чтобы только прочитав его и без визуального представления макета можно было собрать его с ноля. справишься?






У меня достаточно данных для полного документа. Вот детальная спецификация:

Saturn — Design Specification
1. Общие параметры фрейма
Канвас: Несколько экранов, расположенных вертикально на общем холсте
Размер каждого экрана: 1919 × 1034 px
Фон всех экранов: #000000 (чёрный)
Overflow: clip на всех блоках
2. Цветовая палитра
Токен	Значение	Использование
Accent / Primary	#00A8FF	Логотип, активный пункт меню, заголовки карточек, прогресс-бар
Background	#000000	Общий фон экрана и сайдбара
Text Primary	#FFFFFF	Основной текст (opacity: 100%)
Text Muted	rgba(255,255,255,0.80)	Вторичный текст, неактивные пункты меню, подписи
Border	rgba(255,255,255,1)	Обводка карточек, таблиц, внешнего контейнера
Active border	#00A8FF	Обводка активного пункта меню
Active indicator	#00A8FF	Вертикальная полоска-маркер активного пункта
Success	#62FF8C	Статус "Service Reachability"
Corner dots	#D9D9D9	Точки в углах карточек (декор)
Progress fill	#00A8FF	Заполненная часть прогресс-бара
Progress track	transparent + border white	Пустая часть прогресс-бара
3. Типографика
Используемые шрифты
Шрифт	Начертание	Использование
Space Grotesk	Bold	Название приложения "saturn" / заголовки страниц
Consolas	Bold	Всё остальное: меню, метрики, таблицы, карточки
Размеры текста
Роль	Шрифт	Размер	Цвет	Прочее
Логотип в сайдбаре	Space Grotesk Bold	42px	#00A8FF	text-align: center, w: 170px
Заголовок страницы (h1)	Space Grotesk Bold	80px	#00A8FF	line-height: normal
Заголовок карточки	Consolas Bold	24px	#00A8FF	line-height: normal
Значение метрики	Consolas Bold	24px	#FFFFFF	line-height: normal
Мегазаголовок (Storage-строка)	Consolas Bold	80px	mixed	#00A8FF + #FFFFFF в одной строке
Пункты меню (активный)	Consolas Bold	14px	#00A8FF	no opacity
Пункты меню (неактивный)	Consolas Bold	14px	#FFFFFF	opacity: 0.80
Номера пунктов меню	Consolas Bold	14px	#FFFFFF	opacity: 0.80
Подписи в таблице (header)	Consolas Bold	14px	#FFFFFF	opacity: 0.80
Строки таблицы	Consolas Bold	14px	#FFFFFF	line-height: normal
Выбранная строка (имя)	Consolas Bold	14px	#00A8FF	—
Описание в карточке	Consolas Bold	14px	#FFFFFF	opacity: 0.80
Заголовок карточки (строка)	Consolas Bold	24px	#00A8FF	—
Поиск / кнопки	Consolas Bold	14px	#FFFFFF	opacity: 0.80
4. Левый сайдбар
Контейнер
Размер: 250 × 1033 px
Позиция: left: 0, top: 0 (внутри экрана)
Фон: #000000 (черный прямоугольник поверх фонового изображения)
Фоновое изображение: растровое, object-cover, 100% × 100% (декоративное — планета Сатурн в туманности)
Логотип / планета
Изображение планеты: 192 × 192 px, left: 31px, top: 6px (объект Сатурн, синий, нарисованный, на прозрачном фоне)
Текст "saturn": Space Grotesk Bold, 42px, #00A8FF, center, w: 170px, h: 76px, left: 125px (центр), top: 175–177px
Навигационные пункты меню
Все пункты: Consolas Bold, 14px, left: 31px

Пункт	top	Цвет текста	Номер	Номер top	Номер left
Dashboard	299px	#00A8FF (активный)	01	299px	209px
Storage	346px	#FFFFFF 80%	02	346px	209px
Drop Point	391px	#FFFFFF 80%	04	391px	209px
Shared	436px	#FFFFFF 80%	05	436px	209px
Trash	481px	#FFFFFF 80%	06	481px	209px
Settings	526px	#FFFFFF 80%	07	526px	209px
Documentation	943px	#FFFFFF 80%	—	—	—
Logout	988px	#FFFFFF 80%	—	—	—
Активный пункт меню (выделение)
Рамка вокруг активного пункта: border 1px solid #00A8FF, 221 × 42 px, left: 18px, top: 285px (для Dashboard)
Вертикальный маркер-полоска: 4 × 22 px, #00A8FF, left: -2px (выходит за левый край), top: 295px (вертикально центрирован по рамке)
Треугольник-стрелка: SVG, 12 × 5.77 px, #00A8FF, left: 0, top: 306px — указывает вправо
Сдвиг рамки и маркера при активации разных пунктов:

Storage активен → рамка top: 332px, маркер top: 342px, стрелка top: 353px
Drop Point активен → рамка top: 377px, маркер top: 385–387px, стрелка top: 396px
5. Основной контентный контейнер
Внешний бордер
Позиция: left: 250px, top: 123px
Размер: 1670 × 978 px
Стиль: border 1px solid #FFFFFF
Вертикальная линия-разделитель
Горизонтальная линия, повёрнутая на -90°, length: 1034px, white, left: 251px — это граница сайдбара
Заголовок страницы
Space Grotesk Bold, 80px, #00A8FF
Позиция: left: 280px, top: 15px
Размер: 783 × 76 px
6. Dashboard — карточки метрик
Каждая карточка: 790 × 166 px, bg: #000000, border: 1px solid #FFFFFF

Расположение 4 малых карточек (2 × 2 сетка)
Карточка	left	top
CPU Usage	280px	151px
RAM Usage	1100px	151px
Disk Usage	280px	347px
Uptime	1100px	347px
Анатомия карточки (CPU Usage как пример)
Номер карточки: Consolas Bold, 14px, #FFFFFF 80%, left: +10px от карточки, top: +10px
Заголовок: Consolas Bold, 24px, #00A8FF, left: +37px, top: +36px (относительно карточки)
Значение: Consolas Bold, 24px, #FFFFFF, left: +37px, top: +89px
Угловые точки (4 шт.): SVG circle r=2, #D9D9D9, группа 2×2 точки в правом верхнем углу карточки, смещение 8px × 8px между ними, отступ 4px от края
Прогресс-бар (под каждой карточкой)
Высота: 9px
Заполненная часть: #00A8FF, ширина: 392px (≈50% от 790px)
Трек: border 1px solid #FFFFFF, ширина: 790px (полная)
Позиция: примыкает снизу к карточке (top карточки + 166px = top прогрессбара)
Карточка	Прогресс-бар top
CPU (top:151)	308px
RAM (top:151)	308px
Disk (top:347)	504px
Широкая карточка Storage
Размер: 1610 × 166 px, left: 280px, top: 543px
Текст в одну строку, 80px: "Storage " #00A8FF + "50.8% — 458.6/988.2 Gb " #FFFFFF
Прогресс-бар: top: 700px, заполнено 799px из 1610px
Содержимое карточек
Карточка	Метрика	Значение
CPU Usage	% / cores	50.4% — cores: 1
RAM Usage	% / GB	50.3% — 1/1.9 Gb
Disk Usage	% / GB	50.1% — 10/19.7 Gb
Uptime	время	Active: 20h 45m 22s
Storage	% / GB	50.8% — 458.6/988.2 Gb
7. Малые карточки Dashboard (нижняя строка)
Тип: "universal card - 1x - title" — 375 × 166 px

Карточка	left	top
Drop point code (06)	280px	739px
Storage Reachability (07)	695px	739px
Анатомия карточки
Фон + рамка: SVG внутри, rect 375 × 166 black + rect 374 × 165 stroke white 80%, x:0.5, y:0.5
Угловые точки: 4 SVG circles в правом верхнем углу: cx 359 и 367, cy 8 и 16 (r=2, fill #D9D9D9, stroke white 80%, r=1.5)
Номер карточки: Consolas Bold, 14px, #FFFFFF 80%, left: 16px, top: 22px
Заголовок: Consolas Bold, 24px, #00A8FF, left: 41px, top: 15px
Горизонтальная разделительная линия: 1px white 80%, y: 55px, ширина 375px
Описание/контент: Consolas Bold, 14px, #FFFFFF 80%, left: 41px, top: 69px, w: 221px, h: 58px
Карточка "Drop point code"
Описание: "This option creating secure code for drop point activating."
Карточка "Storage Reachability"
Содержит блок статуса:
Рамка: border 1px solid #62FF8C, 255 × 50 px, opacity: 80%, left: 58px, top: 83px
Текст: "Service Reachability", Consolas Bold 14px, #62FF8C 80%, left: 70px, top: 102px
Индикатор: 18 × 18 px, #62FF8C, left: 279px, top: 99px
8. Storage — таблица файлов
Хлебные крошки + мета
Путь: Consolas Bold, 14px, #FFFFFF 80%, left: 280px, top: 152px
Строка: root › folder1 › folder2 › folder3 › folder_i_need
Строка: 15 items · 2 selected · 216 MB
Поиск и Upload
Search: border 1px solid #FFFFFF 80%, 527 × 43 px, left: 1217px, top: 150px
Текст "⌕ Search", Consolas Bold, 14px, left: 1231px, top: 164px
Upload here: border 1px solid #FFFFFF 80%, 124 × 43 px, left: 1766px, top: 150px
Текст "Upload here", Consolas Bold, 14px, left: 1785px, top: 164px
Контейнер таблицы
border 1px solid #FFFFFF, 1611 × 782 px, left: 279px, top: 222px
Заголовок таблицы
Consolas Bold, 14px, #FFFFFF 80%, left: 303px, top: 236px
Текст: NAME / MODIFIED / SIZE / SHARED STATUS
Горизонтальная линия-разделитель: 1px white, y: 262px, ширина: 1610px
Иконки сортировки (колонки)
Двойные стрелки (вверх + вниз), SVG 12 × 5.77 px, white
Позиции по x: 343px (NAME), 567px (MODIFIED), 775px (SIZE)
top: 237px для всех
Строки таблицы
Каждая строка: высота 30px + gap ~11px (top: 286, 327, 376, 414...)

Строка выбрана (selected):

Рамка: border 1px solid #00A8FF, 150 × 30px вокруг имени
Имя файла: #00A8FF
Строка невыбрана:

Рамка: border 1px solid #FFFFFF, 150 × 30px
Имя файла: #FFFFFF
Колонки и позиции (relative to таблице):

Колонка	left (абс.)	Ширина
NAME (текст)	320px	128px
MODIFIED	501px	184px
SIZE	738px	184px
SHARED STATUS	1763px	184px
Пример строк:

folder_i_need_1 / 01 Sep 2026, 18:14 / 185.6 MB → selected (синяя рамка)
folder_i_need_1 / 01 Sep 2026, 18:14 / 2 MB → не выбрана
wpfgfx_cor3.dll / 01 Sep 2026, 18:14 / 4 KB / [ Shared ]
v2rayN.exe / 01 Sep 2026, 18:14 / 7 MB → имя #00A8FF
9. Паттерн угловых точек карточек
Повторяется на всех карточках. Две точки по x (offset 8px), две по y (offset 8px):

● ●    ← cy: 8px
● ●    ← cy: 16px
cx: 359, 367
SVG circle: r=2, fill #D9D9D9, обводка white 80%, r=1.5 (на больших карточках — без обводки, только fill)

10. Разметка экранов (вертикальная стопка на холсте)
Экран	top на холсте	Ширина	Высота
Saturn Left Menu (превью)	2205px	250px	1033px
Saturn Dashboard	3402px	1919px	1034px
Saturn Storage	4498px	1919px	1034px
11. Состояния активного пункта меню
Экран	Активный пункт	Цвет пункта
Dashboard	Dashboard (01)	#00A8FF
Storage	Storage (02)	#00A8FF
Drop Point	Drop Point (03)	#00A8FF
Неактивные пункты всегда: #FFFFFF + opacity 80%.

12. Декоративные SVG-элементы
Стрелка-маркер сайдбара
SVG path, 12 × 5.77 px, #00A8FF
Указывает вправо (→), находится на левом краю (left: 0)
Вертикально центрирована по рамке активного пункта (top = рамка.top + 21px)
Прогресс-стрелки в таблице
Те же SVG 12 × 5.77 px, белые, повёрнуты на ±90° (sort ascending / descending)
Расположены парами рядом с заголовками колонок