# Оновлення коду — порядок, якого тримаємося

Прямі посилання (проєкт Apps Script прив'язаний до реєстру):

| Що | Посилання |
|---|---|
| Свіжий код для копіювання | https://raw.githubusercontent.com/dv-coo/payment-request/main/apps-script/Code.gs |
| Редактор коду | https://script.google.com/home/projects/1JjYZcVskExCXfXM5D4qXQgzRbkyIR0uH7JRFCl7J5XMCd5MStudYhR1U/edit |
| Введення в дію | https://script.google.com/home/projects/1JjYZcVskExCXfXM5D4qXQgzRbkyIR0uH7JRFCl7J5XMCd5MStudYhR1U/deployments |
| Властивості скрипта | https://script.google.com/home/projects/1JjYZcVskExCXfXM5D4qXQgzRbkyIR0uH7JRFCl7J5XMCd5MStudYhR1U/settings |
| Реєстр, лист «Запити» | https://docs.google.com/spreadsheets/d/1lRS7blAUK0zUHywtz7AHhJZoT9VFX4rllC0NvczOj-Q/edit?gid=802103611 |
| Анкета | https://dv-coo.github.io/payment-request/ |

В інтерфейсі Дмитра «Розгорнути» називається **«Ввести в дію»**, «розгортання» — **«введення в дію»**.

## Порядок оновлення

1. Скопіювати код за посиланням вище → у редакторі **Ctrl+A → Delete → Ctrl+V → Ctrl+S**.
2. **«Ввести в дію» ▾ → «Керування введеннями в дію» → ✏️ → поле «Версія» → «Нова версія» → «Ввести в дію»**.
3. Запустити `setup`. Він сам перевіряє, що за `WEBAPP_URL` працює поточне складання, і зупиняється з поясненням, якщо ні.

Зміни лише в `docs/` (анкета) розгортати не треба: GitHub Pages публікує їх сам, за 1–2 хвилини.

## Якщо `setup` каже, що за WEBAPP_URL стара версія

Причина завжди одна: **введень у дію кілька**, нова версія додається не до того, на яке вказує `WEBAPP_URL`.
Не шукати, яке саме, а зробити детерміновано:

1. **«Ввести в дію» ▾ → «Нове введення в дію»** → ⚙️ «Веб-застосунок» → виконувати як **Я**, доступ **Усі** → «Ввести в дію» → **скопіювати URL**.
2. Властивості скрипта → `WEBAPP_URL` = скопійована адреса (закінчується на `/exec`, без пробілу).
3. Запустити `setup`.
4. **Заархівувати всі інші введення в дію**, щоб лишилося одне.

Після кроку 4 звичайне оновлення (пункт 2 вище) знову працює без несподіванок.

## Грабля GitHub Pages

Публікація анкети іноді падає з 500 з боку GitHub, і на сайті лишається стара версія.
Перевіряти: https://github.com/dv-coo/payment-request/actions — останній запуск має бути зелений.
Якщо червоний, перезапустити його або відправити новий коміт.
