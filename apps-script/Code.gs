/**
 * Приймач запитів на оплату → лист «Запити» реєстру запланованих платежів.
 *
 * Одна точка входу (doPost), два види звернень:
 *  - анкета: перевірка підпису Телеграма → ліміти → курс НБУ → новий рядок у «Запити» →
 *    сповіщення й підтвердження контрагенту. Кожне звернення пишеться в лист «Лог»;
 *  - вебхук бота (?tg=секрет): на /start — інструкція з кнопкою анкети, будь-яке інше
 *    повідомлення видаляється, бот лише нагадує про кнопку. Чат з ботом не для листування.
 *
 * Властивості скрипта (Налаштування проєкту → Властивості скрипта):
 *   SHEET_ID         — ID таблиці реєстру
 *   BOT_TOKEN        — токен бота
 *   ADMIN_CHAT_ID    — Telegram ID Дмитра: сповіщення про запити й моніторинг
 * Необов'язкові:
 *   NOTIFY_CHAT_IDS     — кому ще слати сповіщення про запити, ID через кому
 *   WHITELIST_ENABLED   — 'true', щоб пускати лише WHITELIST_IDS (за замовчуванням вимкнено)
 *   WHITELIST_IDS       — Telegram ID через кому
 *   RATE_LIMIT_PER_HOUR — за замовчуванням 5
 *   WEBAPP_URL          — адреса веб-застосунку /exec, якщо setup() не визначить її сам
 */

const SHEET_NAME = 'Запити';
const LOG_SHEET_NAME = 'Лог';
const FORM_URL = 'https://dv-coo.github.io/payment-request/';
const MENU_BUTTON_TEXT = 'Запит на оплату';
const TZ = 'Europe/Kyiv';
const CURRENCIES = ['UAH', 'USD', 'EUR', 'PLN', 'USDT'];
const INIT_DATA_MAX_AGE_SEC = 24 * 3600;

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
  comment:      'Коментар / джерело',
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
    if (recent >= rateLimit_()) {
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
    const res = appendRequest_(clean, user, rate);
    rememberRequest_(tgId);
    log_(tgId, 'прийнято', res.code);

    notifyAccountants_(res.code, clean, user, rate, recent + 1);
    sendMessage_(user.id, 'Запит прийнято. Код: ' + res.code + '\nБухгалтер отримав сповіщення.');

    return json_({ ok: true, code: res.code });
  } catch (err) {
    log_(tgId, 'помилка', String(err && err.stack || err));
    return json_({ ok: false, error: 'Не вдалося зберегти запит. Спробуйте ще раз за хвилину.' });
  }
}

const VERSION = '2026-10-20.1';

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
function appendRequest_(clean, tgUser, rate) {
  const sheet = getSheet_(SHEET_NAME);
  const cols = mapColumns_(sheet);

  // Лок: два одночасні запити не отримають однаковий код і не запишуться в один рядок.
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

    sheet.getRange(row, 1, 1, width).setValues([values]);

    // Формула, а не число: перерахується, коли бухгалтер поправить курс.
    // Без жодного розділювача аргументів (ні «,», ні «;»), тож однаково розбирається
    // за будь-якої локалі таблиці. Курс порожній → ділення на 0 → IFERROR дає порожньо.
    const a = colLetter_(cols.amount + 1) + row;
    const r = colLetter_(cols.rate + 1) + row;
    sheet.getRange(row, cols.amountUah + 1).setFormula('=IFERROR(' + a + '*' + r + '/(' + r + '<>""))');
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

function contacts_(tgUser, name) {
  const handle = tgUser.username ? '@' + tgUser.username : 'tg id ' + tgUser.id;
  return handle + ' ' + name;
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
    log_('', 'помилка', 'бот: ' + (err && err.message || err));
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

function notifyAccountants_(code, c, user, rate, countThisHour) {
  const lines = [
    '🧾 Новий запит на оплату ' + code,
    'Від: ' + c.name + (user.username ? ' (@' + user.username + ')' : ' (tg id ' + user.id + ')'),
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

/* ============================== Лог ============================== */

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
 * перевіряє колонки, створює «Лог», ставить кнопку в бот, вмикає щоденний моніторинг
 * і щомісячний бекап, надсилає пробне повідомлення бухгалтерам і адміну.
 */
function setup() {
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
  ScriptApp.newTrigger('dailyMonitor').timeBased().everyDays(1).atHour(9).inTimezone(TZ).create();
  ScriptApp.newTrigger('monthlyBackup').timeBased().onMonthDay(1).atHour(3).inTimezone(TZ).create();

  const failed = recipients_()
    .filter((id) => !sendMessage_(id, '✅ Приймач запитів на оплату підключено. Сюди приходитимуть сповіщення.'));
  if (failed.length) {
    throw new Error('Бот налаштовано, але не вдалося написати: ' + failed.join(', ') +
      '. Спершу натисніть «Start» у боті, потім запустіть setup() ще раз.');
  }
  Logger.log('Готово. Бот налаштовано, кнопка «%s» веде на %s', MENU_BUTTON_TEXT, FORM_URL);
}

/** Щодня: якщо за добу були спроби, але жодна не пройшла, — сповіщення адміну. */
function dailyMonitor() {
  const sheet = getLogSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return;
  const since = Date.now() - 86400000;
  const first = Math.max(2, last - 999);
  const rows = sheet.getRange(first, 1, last - first + 1, 3).getValues()
    .filter((r) => r[0] instanceof Date && r[0].getTime() > since);
  const accepted = rows.filter((r) => r[2] === 'прийнято').length;
  const errors = rows.filter((r) => r[2] === 'помилка').length;
  if (rows.length && !accepted) {
    sendMessage_(prop_('ADMIN_CHAT_ID'), '⚠️ Форма запитів: за добу ' + rows.length +
      ' спроб, жодна не пройшла (помилок: ' + errors + '). Дивіться лист «Лог».');
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
