/**
 * Приймач запитів на оплату → лист «Запити» реєстру запланованих платежів.
 *
 * Етап 1: збирання рядка і запис у таблицю на фіксованих тестових даних.
 * Веб-входу (doPost) тут навмисно ще немає: він з'явиться разом із перевіркою
 * підпису Телеграма, щоб приймач ніколи не був відкритий без неї.
 *
 * Властивості скрипта (Project Settings → Script properties):
 *   SHEET_ID — ID таблиці. На етапі тестів — ID КОПІЇ реєстру, не бойового.
 */

const SHEET_NAME = 'Запити';

// Назви колонок рівно як у листі «Запити» (рядок 1). Порядок у таблиці не важливий:
// колонки шукаються за назвою.
const COL = {
  status:     'Статус',
  code:       'Код',
  date:       'Дата',
  executor:   'Хто проводить',
  account:    'Рахунок списання',
  requisites: 'Куди платимо — повні реквізити',
  amount:     'Сума за домовленістю',
  currency:   'Валюта',
  rate:       'Курс',
  amountUah:  'Сума в ₴',
  counterparty: 'Контрагент (як у FM)',
  category:   'Категорія (як у FM)',
  project:    'Проєкт',
  comment:    'Коментар / джерело',
  contacts:   'Контакти контрагента',
};

const CURRENCIES = ['UAH', 'USD', 'EUR', 'PLN', 'USDT'];
const TZ = 'Europe/Kyiv';

/**
 * Додає один рядок у лист «Запити». Повертає { code, row }.
 *
 * @param {Object} req
 * @param {string} req.name        Ваше ім'я
 * @param {string} req.payDate     Бажана дата оплати, 'YYYY-MM-DD'
 * @param {string} req.purpose     За що оплата
 * @param {number|string} req.amount Сума за домовленістю
 * @param {string} req.currency    UAH | USD | EUR | PLN | USDT
 * @param {string} req.requisites  Повні реквізити
 * @param {Object} tgUser          Перевірений користувач Телеграма { id, username }
 * @param {number|null} rate       Курс (етап 2); null — лишити порожнім
 */
function appendRequest(req, tgUser, rate) {
  const clean = validateRequest_(req);
  const sheet = getSheet_();
  const cols = mapColumns_(sheet);

  // Лок потрібен, щоб два одночасні запити не отримали однаковий код
  // і не записались в один рядок.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const code = nextCode_(sheet, cols, new Date());
    const row = sheet.getLastRow() + 1;
    const width = sheet.getLastColumn();
    const values = new Array(width).fill('');

    values[cols.code] = code;
    values[cols.date] = clean.payDate;
    values[cols.requisites] = clean.requisites;
    values[cols.amount] = clean.amount;
    values[cols.currency] = clean.currency;
    values[cols.rate] = rate == null ? '' : rate;
    values[cols.counterparty] = clean.name;
    values[cols.comment] = clean.purpose;
    values[cols.contacts] = contacts_(tgUser, clean.name);
    // Статус, Хто проводить, Рахунок списання, Категорія, Проєкт — порожні.

    // Формула, а не число: перерахується, коли бухгалтер поправить курс.
    const a = colLetter_(cols.amount + 1) + row;
    const r = colLetter_(cols.rate + 1) + row;
    values[cols.amountUah] = '=IF(OR(' + a + '="",' + r + '=""),"",' + a + '*' + r + ')';

    // Пишемо тільки в новий рядок під останнім — наявні рядки не чіпаються.
    sheet.getRange(row, 1, 1, width).setValues([values]);
    SpreadsheetApp.flush();
    return { code: code, row: row };
  } finally {
    lock.releaseLock();
  }
}

function validateRequest_(req) {
  const text = (v) => (v == null ? '' : String(v)).trim();
  const out = {
    name: text(req.name),
    purpose: text(req.purpose),
    requisites: text(req.requisites),
    currency: text(req.currency).toUpperCase(),
  };
  const missing = [];
  if (!out.name) missing.push('Ваше ім\'я');
  if (!out.purpose) missing.push('За що оплата');
  if (!out.requisites) missing.push('Куди платимо — повні реквізити');

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(req.payDate));
  if (m) {
    out.payDate = new Date(+m[1], +m[2] - 1, +m[3]);
    if (out.payDate.getMonth() !== +m[2] - 1) out.payDate = null;
  }
  if (!out.payDate) missing.push('Бажана дата оплати');

  out.amount = Number(text(req.amount).replace(/\s/g, '').replace(',', '.'));
  if (!isFinite(out.amount) || out.amount <= 0) missing.push('Сума за домовленістю');

  if (CURRENCIES.indexOf(out.currency) === -1) missing.push('Валюта');

  if (missing.length) throw new Error('Не заповнено або некоректно: ' + missing.join(', '));
  return out;
}

function getSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Не задано властивість скрипта SHEET_ID');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Немає листа «' + SHEET_NAME + '»');
  return sheet;
}

/** Повертає { ключ: індекс колонки з 0 } за назвами в рядку 1. */
function mapColumns_(sheet) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(norm);
  const cols = {};
  const missing = [];
  Object.keys(COL).forEach((key) => {
    const i = headers.indexOf(norm(COL[key]));
    if (i === -1) missing.push(COL[key]);
    cols[key] = i;
  });
  if (missing.length) throw new Error('У листі «' + SHEET_NAME + '» не знайдено колонок: ' + missing.join(', '));
  return cols;
}

/** Код R-РРММДД-NN, NN — наступний вільний номер за день подання. */
function nextCode_(sheet, cols, now) {
  const prefix = 'R-' + Utilities.formatDate(now, TZ, 'yyMMdd') + '-';
  const last = sheet.getLastRow();
  let max = 0;
  if (last >= 2) {
    sheet.getRange(2, cols.code + 1, last - 1, 1).getValues().forEach((r) => {
      const v = String(r[0]);
      if (v.indexOf(prefix) === 0) max = Math.max(max, parseInt(v.slice(prefix.length), 10) || 0);
    });
  }
  return prefix + String(max + 1).padStart(2, '0');
}

function contacts_(tgUser, name) {
  const handle = tgUser && tgUser.username ? '@' + tgUser.username
    : 'tg id ' + (tgUser && tgUser.id ? tgUser.id : '?');
  return handle + ' ' + name;
}

function colLetter_(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ===================== Тести (запускати вручну з редактора) ===================== */

/** Етап 1: додає тестовий рядок у КОПІЮ реєстру. */
function testStage1_appendRow() {
  const res = appendRequest({
    name: 'Тест Тестович',
    payDate: '2026-10-25',
    purpose: 'ТЕСТ етап 1 — видалити',
    amount: '1 500,50',
    currency: 'USD',
    requisites: 'IBAN UA00 0000 0000 0000 0000 0000 000, ФОП Тест',
  }, { id: 111, username: 'test_user' }, 41.5);
  Logger.log('Записано: %s у рядок %s', res.code, res.row);
}

/** Етап 1: перевіряє, що неповна анкета відхиляється і нічого не пишеться. */
function testStage1_rejectsIncomplete() {
  try {
    appendRequest({ name: 'Тест', payDate: '', purpose: '', amount: '', currency: 'XXX', requisites: '' },
      { id: 111 }, null);
    throw new Error('ПРОВАЛ: неповна анкета пройшла');
  } catch (e) {
    if (String(e.message).indexOf('ПРОВАЛ') === 0) throw e;
    Logger.log('OK, відхилено: %s', e.message);
  }
}
