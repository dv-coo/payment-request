/**
 * Приймач запитів на оплату → лист «Запити» реєстру запланованих платежів.
 *
 * Одна точка входу (doPost), два види звернень:
 *  - анкета: перевірка підпису Телеграма → ліміти → курс НБУ → новий рядок у «Запити» →
 *    сповіщення й підтвердження контрагенту. Кожне звернення пишеться в лист «Історія змін»;
 *  - вебхук бота (?tg=секрет): на /start — інструкція з кнопкою анкети, будь-яке інше
 *    повідомлення видаляється, бот лише нагадує про кнопку. Чат з ботом не для листування.
 *
 * Властивості скрипта (Налаштування проєкту → Властивості скрипта):
 *   SHEET_ID         — ID таблиці реєстру
 *   BOT_TOKEN        — токен бота
 *   ADMIN_CHAT_ID    — Telegram ID Дмитра: сповіщення про запити й моніторинг
 *   FINMAP_TOKEN     — ключ API FinMap (заголовок apiKey): довідники категорій, рахунків,
 *                      проєктів і контрагентів
 * Необов'язкові:
 *   NOTIFY_CHAT_IDS     — кому ще слати сповіщення про запити, ID через кому
 *   WHITELIST_ENABLED   — 'true', щоб пускати лише WHITELIST_IDS (за замовчуванням вимкнено)
 *   WHITELIST_IDS       — Telegram ID через кому
 *   RATE_LIMIT_PER_HOUR — за замовчуванням 5
 *   WEBAPP_URL          — адреса веб-застосунку /exec, якщо setup() не визначить її сам
 *   DEFAULT_PROJECT     — проєкт для нових запитів (за замовчуванням DEFAULT_PROJECT нижче)
 */

const SHEET_NAME = 'Запити';
const LOG_SHEET_NAME = 'Історія змін';
const OLD_LOG_SHEET_NAME = 'Лог'; // назва з першої версії — перейменовується автоматично
const SYSTEM_LOG_ID = 'система'; // службові записи (довідники тощо), не звернення людей
const FORM_URL = 'https://dv-coo.github.io/payment-request/';
const MENU_BUTTON_TEXT = 'Запит на оплату';
const TZ = 'Europe/Kyiv';
const CURRENCIES = ['UAH', 'USD', 'EUR', 'PLN', 'USDT'];
const INIT_DATA_MAX_AGE_SEC = 24 * 3600;
const FINMAP_API = 'https://api.finmap.online/v2.2';
const DICT_SHEET_NAME = 'Довідники';
const ARCHIVE_PREFIX = '[Архів]';
const DEFAULT_PROJECT = 'Вища Ліга 6.0';
// Завершені проєкти, які у FinMap не позначені [Архів]. Нові проєкти з'являтимуться в меню самі.
const HIDDEN_PROJECTS = [
  'Вища Ліга 2.0', 'Вища Ліга 3.0', 'Вища Ліга 4.0',
  'Кредитование ВЛ 3.0', 'Кредитование ВЛ 4.0', 'Ліга Інфобізнесу',
];

// Опис бота — його видно в порожньому чаті ще до «Start» (до 512 символів).
const BOT_DESCRIPTION =
  'Бот для запитів на оплату APEX — для підрядників і членів команди.\n\n' +
  'Як подати запит:\n' +
  '1. Натисніть «Start», потім «' + MENU_BUTTON_TEXT + '».\n' +
  '2. Заповніть анкету: ім\'я, бажана дата, за що, сума, валюта, реквізити.\n' +
  '3. Натисніть «Надіслати» — отримаєте код запиту.\n\n' +
  'Запит одразу потрапляє до бухгалтера. Писати в чат не потрібно.';
const BOT_SHORT_DESCRIPTION = 'Запити на оплату для підрядників і команди APEX. Подача — через анкету, за 1 хвилину.';

const START_TEXT =
  '👋 Вітаю! Тут подають запити на оплату для APEX.\n\n' +
  'Як це працює:\n' +
  '1. Натисніть кнопку «📝 Подати запит» нижче (або «' + MENU_BUTTON_TEXT + '» біля поля вводу).\n' +
  '2. Заповніть 6 полів: ім\'я, бажана дата оплати, за що, сума, валюта і повні реквізити.\n' +
  '3. Натисніть «Надіслати». Ви отримаєте код запиту — збережіть його.\n\n' +
  'Запит одразу потрапляє до бухгалтера. Кожен окремий платіж — окремий запит.\n' +
  'Писати в цей чат не потрібно: повідомлення не читаються.';

const NO_CHAT_TEXT = 'Цей бот не приймає повідомлень. Щоб передати запит на оплату — натисніть кнопку нижче.';

// Назви колонок рівно як у листі «Запити» (рядок 1). Колонки шукаються за назвою.
const COL = {
  status:       'Статус',
  code:         'Код',
  date:         'Дата',
  executor:     'Хто проводить',
  account:      'Рахунок списання',
  requisites:   'Куди платимо — повні реквізити',
  amount:       'Сума за домовленістю',
  currency:     'Валюта',
  rate:         'Курс',
  amountUah:    'Сума в ₴',
  counterparty: 'Контрагент (як у FM)',
  category:     'Категорія (як у FM)',
  project:      'Проєкт',
  comment:      ['Коментар', 'Коментар / джерело'], // друга — назва з першої версії
  contacts:     'Контакти контрагента',
};

/* ================================ Вхід ================================ */

// Фронт шле text/plain, щоб браузер не робив CORS-preflight, якого Apps Script не обробляє.
function doPost(e) {
  if (e.parameter && e.parameter.tg) return handleBotUpdate_(e);
  let tgId = '';
  try {
    const body = JSON.parse(e.postData.contents);
    const user = verifyInitData_(body.initData, prop_('BOT_TOKEN', true));
    if (!user) {
      log_('', 'відхилено', 'підпис Телеграма не сходиться');
      return json_({ ok: false, error: 'Відкрийте анкету через бот.' });
    }
    tgId = String(user.id);

    if (!isAllowed_(tgId)) {
      log_(tgId, 'відхилено', 'немає в білому списку');
      return json_({ ok: false, error: 'Доступ до анкети закрито. Зверніться до бухгалтера.' });
    }

    const recent = recentTimes_(tgId).length;
    const isAdmin = idList_(prop_('ADMIN_CHAT_ID')).indexOf(tgId) !== -1; // адміну ліміт не потрібен
    if (!isAdmin && recent >= rateLimit_()) {
      log_(tgId, 'відхилено', 'ліміт запитів за годину');
      return json_({ ok: false, error: 'Забагато запитів за годину. Спробуйте пізніше.' });
    }

    let clean;
    try {
      clean = validateRequest_(body.form || {});
    } catch (err) {
      log_(tgId, 'відхилено', err.message);
      return json_({ ok: false, error: err.message });
    }

    const rate = fetchRate_(clean.currency, new Date());
    const fmName = matchCounterparty_(clean.name);
    const res = appendRequest_(clean, user, rate, fmName);
    rememberRequest_(tgId);
    log_(tgId, 'прийнято', res.code);

    notifyAccountants_(res.code, clean, user, rate, recent + 1, fmName);
    sendMessage_(user.id, 'Запит прийнято. Код: ' + res.code + '\nБухгалтер отримав сповіщення.');

    return json_({ ok: true, code: res.code });
  } catch (err) {
    log_(tgId, 'помилка', String(err && err.stack || err));
    return json_({ ok: false, error: 'Не вдалося зберегти запит. Спробуйте ще раз за хвилину.' });
  }
}

const VERSION = '2026-10-22.2';

// Відкрити адресу …/exec у браузері — покаже, яка версія коду зараз опублікована.
function doGet() {
  return ContentService.createTextOutput('ok ' + VERSION);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ======================== Підпис Телеграма ======================== */

/**
 * Перевіряє initData міні-застосунку. Повертає об'єкт user або null.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function verifyInitData_(initData, botToken, nowSec) {
  if (!initData || typeof initData !== 'string') return null;
  const params = {};
  initData.split('&').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i <= 0) return;
    params[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
  });
  const hash = params.hash;
  if (!hash) return null;
  delete params.hash;

  const dataCheckString = Object.keys(params).sort().map((k) => k + '=' + params[k]).join('\n');
  const secret = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(botToken).getBytes(), Utilities.newBlob('WebAppData').getBytes());
  const sig = Utilities.computeHmacSha256Signature(Utilities.newBlob(dataCheckString).getBytes(), secret);
  if (toHex_(sig) !== String(hash).toLowerCase()) return null;

  const now = nowSec || Math.floor(Date.now() / 1000);
  if (!(now - Number(params.auth_date) < INIT_DATA_MAX_AGE_SEC)) return null;

  try {
    const user = JSON.parse(params.user);
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

function toHex_(bytes) {
  return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/* ========================= Доступ і ліміти ========================= */

function isAllowed_(tgId) {
  if (String(prop_('WHITELIST_ENABLED') || '').toLowerCase() !== 'true') return true;
  return idList_(prop_('WHITELIST_IDS')).indexOf(tgId) !== -1;
}

function rateLimit_() {
  return Number(prop_('RATE_LIMIT_PER_HOUR')) || 5;
}

function recentTimes_(tgId) {
  const raw = PropertiesService.getScriptProperties().getProperty('rl_' + tgId);
  const hourAgo = Date.now() - 3600 * 1000;
  return (raw ? JSON.parse(raw) : []).filter((t) => t > hourAgo);
}

function rememberRequest_(tgId) {
  const times = recentTimes_(tgId);
  times.push(Date.now());
  PropertiesService.getScriptProperties().setProperty('rl_' + tgId, JSON.stringify(times));
}

/* =========================== Валідація =========================== */

function validateRequest_(req) {
  const text = (v) => (v == null ? '' : String(v)).trim();
  const out = {
    name: text(req.name).slice(0, 200),
    purpose: text(req.purpose).slice(0, 2000),
    requisites: text(req.requisites).slice(0, 2000),
    currency: text(req.currency).toUpperCase(),
  };
  const missing = [];
  if (!out.name) missing.push('Ваше ім\'я');

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(req.payDate));
  if (m) {
    out.payDate = new Date(+m[1], +m[2] - 1, +m[3]);
    if (out.payDate.getMonth() !== +m[2] - 1) out.payDate = null;
  }
  if (!out.payDate) missing.push('Бажана дата оплати');

  if (!out.purpose) missing.push('За що оплата');

  out.amount = Number(text(req.amount).replace(/\s/g, '').replace(',', '.'));
  if (!isFinite(out.amount) || out.amount <= 0) missing.push('Сума за домовленістю');

  if (CURRENCIES.indexOf(out.currency) === -1) missing.push('Валюта');
  if (!out.requisites) missing.push('Куди платимо — повні реквізити');

  if (missing.length) throw new Error('Не заповнено або некоректно: ' + missing.join(', '));
  return out;
}

/* ============================ Курс НБУ ============================ */

/** Курс НБУ на дату; якщо на день курсу немає — останній установлений. null, якщо НБУ недоступний. */
function fetchRate_(currency, date) {
  if (currency === 'UAH') return 1;
  const code = currency === 'USDT' ? 'USD' : currency;
  try {
    for (let back = 0; back < 7; back++) {
      const d = new Date(date.getTime() - back * 86400000);
      const url = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=' + code +
        '&date=' + Utilities.formatDate(d, TZ, 'yyyyMMdd') + '&json';
      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) return null;
      const data = JSON.parse(resp.getContentText());
      if (data.length && data[0].rate) return data[0].rate;
    }
  } catch (e) {
    // Недоступність НБУ не блокує запит.
  }
  return null;
}

/* ============================== Запис ============================== */

/** Додає один рядок у лист «Запити». Повертає { code, row }. Наявні рядки не змінює. */
function appendRequest_(clean, tgUser, rate, fmName) {
  const sheet = getSheet_(SHEET_NAME);
  const cols = mapColumns_(sheet);

  // Лок: два одночасні запити не отримають однаковий код і не запишуться в один рядок.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const code = nextCode_(sheet, cols, new Date());
    const row = sheet.getLastRow() + 1;
    if (row > sheet.getMaxRows()) {
      sheet.insertRowsAfter(sheet.getMaxRows(), 100);
      const dict = sheet.getParent().getSheetByName(DICT_SHEET_NAME);
      if (dict) applyValidations_(sheet, dict);
    }
    const width = sheet.getLastColumn();
    const values = new Array(width).fill('');

    values[cols.code] = code;
    values[cols.date] = clean.payDate;
    values[cols.requisites] = clean.requisites;
    values[cols.amount] = clean.amount;
    values[cols.currency] = clean.currency;
    values[cols.rate] = rate == null ? '' : rate;
    values[cols.counterparty] = fmName || ''; // ім'я як у FinMap; як написала людина — у «Контактах»
    values[cols.comment] = clean.purpose;
    const contact = contacts_(tgUser, clean.name);
    values[cols.contacts] = contact.text;
    values[cols.project] = prop_('DEFAULT_PROJECT') || DEFAULT_PROJECT; // у меню можна змінити
    // Статус, Хто проводить, Рахунок списання, Категорія — порожні.

    sheet.getRange(row, 1, 1, width).setValues([values]);

    // Формула, а не число: перерахується, коли бухгалтер поправить курс.
    // Без жодного розділювача аргументів (ні «,», ні «;»), тож однаково розбирається
    // за будь-якої локалі таблиці. Курс порожній → ділення на 0 → IFERROR дає порожньо.
    const a = colLetter_(cols.amount + 1) + row;
    const r = colLetter_(cols.rate + 1) + row;
    sheet.getRange(row, cols.amountUah + 1).setFormula('=IFERROR(' + a + '*' + r + '/(' + r + '<>""))');
    if (contact.url) {
      // Посилання в клітинці: клік відкриває чат з людиною в Телеграмі.
      sheet.getRange(row, cols.contacts + 1).setRichTextValue(SpreadsheetApp.newRichTextValue()
        .setText(contact.text)
        .setLinkUrl(contact.text.length - contact.url.length, contact.text.length, contact.url)
        .build());
    }
    SpreadsheetApp.flush();
    return { code: code, row: row };
  } finally {
    lock.releaseLock();
  }
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

/**
 * Ім'я як написала людина + посилання на чат з нею. Без ніка в Телеграмі посилання на чат
 * не буває — тоді лише Telegram ID.
 */
function contacts_(tgUser, name) {
  if (!tgUser.username) return { text: name + ' — tg id ' + tgUser.id, url: '' };
  const url = 'https://t.me/' + tgUser.username;
  return { text: name + ' — ' + url, url: url };
}

/** Повертає { ключ: індекс колонки з 0 } за назвами в рядку 1. */
function mapColumns_(sheet) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(norm);
  const cols = {};
  const missing = [];
  Object.keys(COL).forEach((key) => {
    const names = [].concat(COL[key]);
    const found = names.map((n) => headers.indexOf(norm(n))).filter((i) => i !== -1);
    if (!found.length) missing.push(names[0]);
    cols[key] = found.length ? found[0] : -1;
  });
  if (missing.length) throw new Error('У листі «' + SHEET_NAME + '» не знайдено колонок: ' + missing.join(', '));
  return cols;
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

/* ======================== Вебхук бота ======================== */

/**
 * Оновлення від Телеграма. Apps Script не бачить заголовків, тому справжність перевіряємо
 * секретом у адресі вебхука. Телеграм отримує від Apps Script редирект замість 200 і може
 * повторити те саме оновлення — тому дедуплікація за update_id.
 */
function handleBotUpdate_(e) {
  const ok = ContentService.createTextOutput('ok');
  try {
    if (e.parameter.tg !== prop_('TG_WEBHOOK_SECRET')) return ok;
    const update = JSON.parse(e.postData.contents);
    const cache = CacheService.getScriptCache();
    const seenKey = 'upd_' + update.update_id;
    if (cache.get(seenKey)) return ok;
    cache.put(seenKey, '1', 21600);

    const msg = update.message;
    if (!msg || !msg.chat || msg.chat.type !== 'private') return ok;
    const chatId = msg.chat.id;

    if (/^\/start\b/.test(msg.text || '')) {
      sendWithFormButton_(chatId, START_TEXT);
      return ok;
    }

    // Будь-що інше — прибираємо з чату; нагадування не частіше разу на 10 хв.
    try {
      telegram_('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    } catch (err) {
      // Не вдалося видалити (напр., службове повідомлення) — не страшно.
    }
    const hintKey = 'hint_' + chatId;
    if (!cache.get(hintKey)) {
      cache.put(hintKey, '1', 600);
      sendWithFormButton_(chatId, NO_CHAT_TEXT);
    }
  } catch (err) {
    log_(SYSTEM_LOG_ID, 'помилка', 'бот: ' + (err && err.message || err));
  }
  return ok;
}

function sendWithFormButton_(chatId, text) {
  try {
    telegram_('sendMessage', {
      chat_id: chatId,
      text: text,
      reply_markup: { inline_keyboard: [[{ text: '📝 Подати запит', web_app: { url: formUrl_() } }]] },
    });
  } catch (err) {
    log_(String(chatId), 'помилка', 'sendMessage: ' + err.message);
  }
}

/** Адреса цього веб-застосунку (…/exec). */
function execUrl_() {
  const url = prop_('WEBAPP_URL') || ScriptApp.getService().getUrl();
  if (!url || !/\/exec$/.test(url)) {
    throw new Error('Не вдалося визначити адресу веб-застосунку. Спершу «Розгорнути → Нове розгортання», ' +
      'або додайте властивість WEBAPP_URL (адреса, що закінчується на /exec).');
  }
  return url;
}

/** Адреса анкети з параметром api — куди анкета шле дані. */
function formUrl_() {
  return FORM_URL + '?api=' + encodeURIComponent(execUrl_());
}

/* ============================ Телеграм ============================ */

function notifyAccountants_(code, c, user, rate, countThisHour, fmName) {
  const lines = [
    '🧾 Новий запит на оплату ' + code,
    'Від: ' + c.name + (user.username ? ' (@' + user.username + ')' : ' (tg id ' + user.id + ')'),
    fmName ? 'У FM: ' + fmName : '⚠️ Контрагента в FM не знайдено — оберіть у колонці «Контрагент (як у FM)».',
    'Сума: ' + formatAmount_(c.amount) + ' ' + c.currency,
    'Бажана дата: ' + Utilities.formatDate(c.payDate, TZ, 'dd.MM.yyyy'),
    'За що: ' + c.purpose,
  ];
  if (rate == null) lines.push('⚠️ Курс НБУ не підтягнувся — поставте вручну.');
  if (countThisHour > 1) lines.push('ℹ️ Це ' + countThisHour + '-й запит від цієї людини за годину — перевірте на дубль.');
  recipients_().forEach((id) => sendMessage_(id, lines.join('\n')));
}

function sendMessage_(chatId, text) {
  try {
    telegram_('sendMessage', { chat_id: chatId, text: text, disable_web_page_preview: true });
    return true;
  } catch (e) {
    log_(String(chatId), 'помилка', 'sendMessage: ' + e.message);
    return false;
  }
}

function telegram_(method, payload) {
  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('BOT_TOKEN', true) + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) throw new Error(method + ': ' + data.description);
  return data.result;
}

function formatAmount_(n) {
  const [int, frac] = n.toFixed(2).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (frac === '00' ? '' : ',' + frac);
}

/* =========================== Історія змін =========================== */

function log_(tgId, result, details) {
  try {
    getLogSheet_().appendRow([new Date(), tgId, result, String(details || '').slice(0, 1000)]);
  } catch (e) {
    console.error('log_ failed', e, tgId, result, details);
  }
}

function getLogSheet_() {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID', true));
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet && ss.getSheetByName(OLD_LOG_SHEET_NAME)) {
    sheet = ss.getSheetByName(OLD_LOG_SHEET_NAME).setName(LOG_SHEET_NAME);
  }
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['Час', 'Telegram ID', 'Результат', 'Деталі']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* ========================= Обслуговування ========================= */

/**
 * Запустити ОДИН раз після публікації веб-застосунку. Робить усе налаштування:
 * перевіряє колонки, створює «Історія змін», налаштовує бота, підтягує довідники з FinMap
 * і ставить спадні меню, вмикає щоденні оновлення, моніторинг і щомісячний бекап,
 * надсилає пробне повідомлення адміну. Безпечно запускати повторно.
 */
function setup() {
  checkDeployedVersion_();
  renameHeader_(getSheet_(SHEET_NAME), 'Коментар / джерело', 'Коментар');
  mapColumns_(getSheet_(SHEET_NAME));
  getLogSheet_();

  const form = formUrl_();

  // Профіль бота: опис до «Start», без списку команд, кнопка анкети біля поля вводу.
  telegram_('setMyDescription', { description: BOT_DESCRIPTION });
  telegram_('setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION });
  telegram_('deleteMyCommands', {});
  telegram_('setChatMenuButton', {
    menu_button: { type: 'web_app', text: MENU_BUTTON_TEXT, web_app: { url: form } },
  });

  // Вебхук: бот відповідає на /start і прибирає інші повідомлення.
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('TG_WEBHOOK_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TG_WEBHOOK_SECRET', secret);
  }
  telegram_('setWebhook', {
    url: execUrl_() + '?tg=' + secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });

  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncDictionaries').timeBased().everyDays(1).atHour(8).inTimezone(TZ).create();
  ScriptApp.newTrigger('dailyMonitor').timeBased().everyDays(1).atHour(9).inTimezone(TZ).create();
  ScriptApp.newTrigger('monthlyBackup').timeBased().onMonthDay(1).atHour(3).inTimezone(TZ).create();

  const failed = recipients_()
    .filter((id) => !sendMessage_(id, '✅ Приймач запитів на оплату підключено. Сюди приходитимуть сповіщення.'));
  if (failed.length) {
    throw new Error('Бот налаштовано, але не вдалося написати: ' + failed.join(', ') +
      '. Спершу натисніть «Start» у боті, потім запустіть setup() ще раз.');
  }
  const sync = syncDictionaries();
  if (sync.errors.length) {
    throw new Error('Бот налаштовано, але не всі довідники з FinMap підтягнулися: ' + sync.errors.join('; '));
  }
  Logger.log('Готово. Довідники з FinMap: %s', JSON.stringify(sync.counts));
}

/** Щодня: якщо за добу були спроби, але жодна не пройшла, — сповіщення адміну. */
function dailyMonitor() {
  const sheet = getLogSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return;
  const since = Date.now() - 86400000;
  const first = Math.max(2, last - 999);
  const rows = sheet.getRange(first, 1, last - first + 1, 4).getValues()
    .filter((r) => r[0] instanceof Date && r[0].getTime() > since)
    .filter((r) => r[1] !== SYSTEM_LOG_ID); // службові записи — не спроби подати запит
  const accepted = rows.filter((r) => r[2] === 'прийнято').length;
  const errors = rows.filter((r) => r[2] === 'помилка').length;
  if (rows.length && !accepted) {
    sendMessage_(prop_('ADMIN_CHAT_ID'), '⚠️ Форма запитів: за добу ' + rows.length +
      ' спроб, жодна не пройшла (помилок: ' + errors + '). Дивіться лист «Історія змін».');
  }
}

/** Раз на місяць: копія реєстру в папку «Архів реєстру платежів» на Диску. */
function monthlyBackup() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('ARCHIVE_FOLDER_ID');
  let folder = null;
  try {
    if (folderId) folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    folder = null;
  }
  if (!folder) {
    folder = DriveApp.createFolder('Архів реєстру платежів');
    props.setProperty('ARCHIVE_FOLDER_ID', folder.getId());
  }
  const file = DriveApp.getFileById(prop_('SHEET_ID', true));
  file.makeCopy(file.getName() + ' — ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), folder);
}

/* ============================== FinMap ============================== */

// Довідники в прихованому аркуші «Довідники»: по колонці на кожен, у порядку цього списку.
// key — колонка «Запитів», яка отримує спадне меню. Перший шлях обов'язковий, решта —
// додаткові: частину старих розділів API FinMap позначено застарілими, їх просто пропускаємо.
const DICTS = [
  { key: 'category',     title: 'Категорії',   paths: ['/categories/expense'] },
  { key: 'account',      title: 'Рахунки',     paths: ['/accounts'] },
  { key: 'project',      title: 'Проєкти',     paths: ['/projects'], hide: HIDDEN_PROJECTS },
  { key: 'counterparty', title: 'Контрагенти', paths: ['/suppliers', '/employees', '/owners', '/creditors'] },
];

/**
 * Щодня: оновлює довідники з FinMap і спадні меню в «Запити». Якщо якийсь список FinMap
 * не віддав — лишається попередній, причина йде в «Історія змін» і адміну в бот.
 * Повертає { counts, errors }.
 */
function syncDictionaries() {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID', true));
  let dict = ss.getSheetByName(DICT_SHEET_NAME);
  if (!dict) {
    dict = ss.insertSheet(DICT_SHEET_NAME);
    dict.hideSheet();
  }
  const counts = {};
  const errors = [];
  DICTS.forEach((d, i) => {
    try {
      const labels = finmapLabels_(d.paths, d.hide);
      if (dict.getMaxRows() < labels.length + 1) {
        dict.insertRowsAfter(dict.getMaxRows(), labels.length + 1 - dict.getMaxRows());
      }
      dict.getRange(1, i + 1, dict.getMaxRows(), 1).clearContent();
      dict.getRange(1, i + 1, labels.length + 1, 1).setValues([[d.title]].concat(labels.map((l) => [l])));
      counts[d.key] = labels.length;
    } catch (e) {
      errors.push(d.title + ': ' + e.message);
      log_(SYSTEM_LOG_ID, 'помилка', 'FinMap ' + d.title + ': ' + e.message);
    }
  });
  applyValidations_(getSheet_(SHEET_NAME), dict);
  if (errors.length) {
    sendMessage_(prop_('ADMIN_CHAT_ID'), '⚠️ Довідники з FinMap не оновились: ' + errors.join('; ') +
      '\nСпадні меню працюють зі старим списком.');
  }
  return { counts: counts, errors: errors };
}

/** Назви зі списків FinMap: без системних, [Архів] і прихованих (hide), без дублів, за алфавітом. */
function finmapLabels_(paths, hide) {
  const labels = [];
  paths.forEach((path, i) => {
    const resp = UrlFetchApp.fetch(FINMAP_API + path, {
      headers: { apiKey: prop_('FINMAP_TOKEN', true), Accept: 'application/json' },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) {
      if (i === 0) throw new Error(path + ': код ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200));
      return;
    }
    JSON.parse(resp.getContentText()).forEach((item) => {
      const label = String(item.label || '').replace(/\s+/g, ' ').trim();
      if (label && !item.isSystem && label.indexOf(ARCHIVE_PREFIX) !== 0 && (hide || []).indexOf(label) === -1) {
        labels.push(label);
      }
    });
  });
  const unique = [...new Set(labels)];
  if (!unique.length) throw new Error(paths[0] + ': FinMap повернув порожній список');
  return unique.sort((a, b) => a.localeCompare(b, 'uk'));
}

/**
 * Спадні меню в «Запити» з другого рядка до кінця аркуша:
 *  - категорія, рахунок, проєкт, контрагент — зі списків у «Довідниках». Значення поза
 *    списком дає попередження, а не помилку, тож вручну вводити можна;
 *  - «Статус» і «Хто проводить» — копія меню з рядка 2, яке налаштоване вручну.
 */
function applyValidations_(sheet, dict) {
  const cols = mapColumns_(sheet);
  const rows = Math.max(1, sheet.getMaxRows() - 1);
  DICTS.forEach((d, i) => {
    const n = dict.getRange(1, i + 1, dict.getMaxRows(), 1).getValues().filter((r) => r[0] !== '').length - 1;
    if (n < 1) return;
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(dict.getRange(2, i + 1, n, 1), true)
      .setAllowInvalid(true)
      .build();
    sheet.getRange(2, cols[d.key] + 1, rows, 1).setDataValidation(rule);
  });
  ['status', 'executor'].forEach((key) => {
    const template = sheet.getRange(2, cols[key] + 1).getDataValidation();
    if (template) {
      sheet.getRange(2, cols[key] + 1, rows, 1).setDataValidation(template);
    } else {
      log_(SYSTEM_LOG_ID, 'помилка', 'У рядку 2 колонки «' + COL[key] + '» немає спадного меню — нема що копіювати');
    }
  });
}

/* ===================== Підбір контрагента з FinMap ===================== */

// Варіанти одного імені (укр/рос/скорочені). Слово може бути в кількох групах («Саша»).
const NAME_GROUPS = [
  'олександр александр алекс саша шура', 'олександра александра саша', 'дмитро дмитрий дима',
  'анастасія анастасия настя', 'наталія наталья наталя натали наталі наташа', 'катерина екатерина катя',
  'вікторія виктория віка вика', 'юлія юлия юля', 'марія мария маша', 'олексій алексей льоша леша',
  'ірина ирина іра ира', 'ольга оля', 'анна ганна аня', "єлизавета елизавета ліза лиза",
  'владислав влад', 'владислава влада', 'валерія валерия лера', 'валентина валя', 'микола николай коля',
  'павло павел паша', 'сергій сергей', 'андрій андрей', 'іван иван ваня', 'кирило кирилл',
  'олена елена алена альона лена', 'тетяна татьяна таня', 'софія софия соня', 'роман рома',
  'євген евгений женя', 'євгенія евгения женя', 'ростислав слава', 'ярослав слава', 'станіслав стас',
  'василь василий вася', "дарія дарья дария даша", 'максим макс', 'нікіта никита микита',
  'данило данил даниил', 'михайло михаил миша', 'надія надежда надя', 'людмила люда',
  'світлана светлана света', 'галина галя', 'поліна полина', 'мирослава мира', 'богдан бодя',
];
const NAME_STOPWORDS = ['фоп', 'ффоп', 'тов', 'пп', 'fop'];
let nameGroupIndex_ = null;

/**
 * Найближче до введеного ім'я з довідника контрагентів, або '' якщо надійного збігу немає.
 * Враховує порядок слів, укр/рос написання, латинські літери в кириличних словах, «ФОП»,
 * по батькові, ініціали, зменшувальні імена й дрібні одруківки.
 */
function matchCounterparty_(name) {
  try {
    const dict = SpreadsheetApp.openById(prop_('SHEET_ID', true)).getSheetByName(DICT_SHEET_NAME);
    if (!dict) return '';
    const col = DICTS.findIndex((d) => d.key === 'counterparty') + 1;
    const labels = dict.getRange(2, col, Math.max(1, dict.getMaxRows() - 1), 1).getValues()
      .map((r) => String(r[0])).filter(Boolean);
    return bestNameMatch_(name, labels);
  } catch (e) {
    log_(SYSTEM_LOG_ID, 'помилка', 'Підбір контрагента: ' + e.message);
    return '';
  }
}

function bestNameMatch_(name, labels) {
  const q = nameTokens_(name);
  if (!q.length) return '';
  let best = null;
  labels.forEach((label) => {
    const c = nameTokens_(label);
    if (!c.length) return;
    const m = nameScore_(q, c);
    if (!m.ok) return;
    const better = !best || m.score > best.score + 1e-9 ||
      (Math.abs(m.score - best.score) < 1e-9 &&
        (m.exact > best.exact || (m.exact === best.exact && label.length > best.label.length)));
    if (better) best = { label: label, score: m.score, exact: m.exact };
  });
  return best ? best.label : '';
}

function nameScore_(q, c) {
  const optional = (t) => t.length === 1 || isPatronymic_(t); // ініціали й по батькові
  let sum = 0;
  let weight = 0;
  let exact = 0;
  let anchor = false; // є збіг по слову, яке не є просто поширеним ім'ям (прізвище тощо)
  let meaningful = 0; // скільки слів імені «працює»: повні слова й ініціали, що збіглися
  q.forEach((t) => {
    let bestSim = 0;
    c.forEach((u) => { bestSim = Math.max(bestSim, tokenSim_(t, u)); });
    if (c.indexOf(t) !== -1) exact++;
    if (bestSim >= 0.85 && t.length >= 3 && !nameGroups_()[t]) anchor = true;
    if (optional(t)) {
      // Збіг ініціала чи по батькові — повний плюс; відсутність — легкий мінус.
      if (bestSim > 0) { sum += 1; weight += 1; meaningful++; } else { weight += 0.15; }
      return;
    }
    sum += bestSim;
    weight++;
    meaningful++;
  });
  // Яку частку «справжніх» слів кандидата пояснює введене ім'я (по батькові кандидата не штрафує).
  const isCovered = (u) => q.some((t) => tokenSim_(t, u) >= 0.6);
  const counted = c.filter((u) => !optional(u) || isCovered(u));
  const covered = counted.filter(isCovered).length;
  const score = weight ? 0.8 * (sum / weight) + 0.2 * (counted.length ? covered / counted.length : 0) : 0;
  const sameTokens = q.length === c.length && q.every((t) => c.indexOf(t) !== -1);
  // Одне слово (лише ім'я чи лише прізвище) — тільки точний збіг: інакше легко вгадати не ту людину.
  return { score: score, exact: exact, ok: sameTokens || (meaningful >= 2 && anchor && score >= 0.75) };
}

function tokenSim_(a, b) {
  if (a === b) return 1;
  const ga = nameGroups_()[a];
  const gb = nameGroups_()[b];
  if (ga && gb && ga.some((g) => gb.indexOf(g) !== -1)) return 1;
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? 0.6 : 0;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  if (short.length >= 4 && long.indexOf(short) === 0) return 0.85; // Губарев / Губарева
  const r = 1 - levenshtein_(a, b) / long.length;
  return r >= 0.8 ? r : 0;
}

function isPatronymic_(t) {
  return /(ович|евич|ич|ивна|овна|евна|ична)$/.test(t) && t.length > 5;
}

function nameGroups_() {
  if (!nameGroupIndex_) {
    nameGroupIndex_ = {};
    NAME_GROUPS.forEach((g, i) => g.split(' ').forEach((w) => {
      const k = foldName_(w);
      (nameGroupIndex_[k] = nameGroupIndex_[k] || []).push(i);
    }));
  }
  return nameGroupIndex_;
}

function nameTokens_(s) {
  return String(s || '').toLowerCase().split(/[^a-zа-яіїєґёыэъ'’ʼ`]+/i)
    .map(foldName_).filter((t) => t && NAME_STOPWORDS.indexOf(t) === -1);
}

/** Спільна форма для укр/рос написання; латинські двійники в кириличних словах → кирилиця. */
function foldName_(w) {
  let t = String(w).toLowerCase();
  if (/[а-яіїєґё]/.test(t)) {
    const lat = { a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в' };
    t = t.replace(/[aceiopxykmthb]/g, (ch) => lat[ch]);
  }
  return t.replace(/[іїы]/g, 'и').replace(/[єэё]/g, 'е').replace(/ґ/g, 'г').replace(/[ьъ'’ʼ`]/g, '');
}

function levenshtein_(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Анкета шле запити на WEBAPP_URL, а там працює та версія коду, яку опубліковано в розгортанні,
 * а не та, що в редакторі. Якщо вони розійшлися — зупиняємось і кажемо, що зробити.
 */
function checkDeployedVersion_() {
  const got = UrlFetchApp.fetch(execUrl_(), { muteHttpExceptions: true, followRedirects: true })
    .getContentText().trim();
  if (got !== 'ok ' + VERSION) {
    throw new Error('За адресою WEBAPP_URL працює інша версія коду («' + got.slice(0, 30) + '»), ' +
      'а в редакторі — ' + VERSION + '. Запити з анкети обробляє стара версія. ' +
      '«Розгорнути» → «Керування розгортаннями» → розгортання з адресою з WEBAPP_URL → ✏️ → ' +
      '«Версія: Нова версія» → «Розгорнути». Потім запустіть setup ще раз.');
  }
}

/** Перейменовує заголовок колонки в «Запити», якщо він ще під старою назвою. */
function renameHeader_(sheet, from, to) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const i = headers.findIndex((h) => String(h).replace(/\s+/g, ' ').trim() === from);
  if (i !== -1) sheet.getRange(1, i + 1).setValue(to);
}

/* ============================== Утиліти ============================== */

function getSheet_(name) {
  const sheet = SpreadsheetApp.openById(prop_('SHEET_ID', true)).getSheetByName(name);
  if (!sheet) throw new Error('Немає листа «' + name + '»');
  return sheet;
}

function prop_(key, required) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !v) throw new Error('Не задано властивість скрипта ' + key);
  return v;
}

/** Адмін + додаткові отримувачі, без повторів. */
function recipients_() {
  const ids = idList_(prop_('ADMIN_CHAT_ID', true)).concat(idList_(prop_('NOTIFY_CHAT_IDS')));
  return ids.filter((id, i) => ids.indexOf(id) === i);
}

function idList_(s) {
  return String(s || '').split(/[\s,;]+/).filter(Boolean);
}
