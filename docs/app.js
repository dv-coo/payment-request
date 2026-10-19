(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var api = new URLSearchParams(location.search).get('api');

  var form = document.getElementById('form');
  var submit = document.getElementById('submit');
  var errorBox = document.getElementById('error');
  function f(name) { return form.elements.namedItem(name); }

  // Відкрито з великої кнопки внизу чату: Телеграм не дає таким анкетам initData,
  // тому дані йдуть через tg.sendData — повідомленням у чат від імені людини.
  var inTelegram = !!(tg && tg.platform && tg.platform !== 'unknown');
  var viaKeyboard = inTelegram && !tg.initData;
  if (!inTelegram || (!viaKeyboard && !api)) {
    form.hidden = true;
    document.getElementById('outside').hidden = false;
    return;
  }
  // Перший раз інструкцію розгорнуто, далі — згорнуто.
  try {
    if (!localStorage.getItem('howtoSeen')) {
      document.getElementById('howto').open = true;
      localStorage.setItem('howtoSeen', '1');
    }
  } catch (e) {
    document.getElementById('howto').open = true;
  }
  tg.ready();
  tg.expand();
  tg.setHeaderColor && tg.setHeaderColor('#e2ecf4');
  tg.setBackgroundColor && tg.setBackgroundColor('#e2ecf4');

  // Підставити ім'я з Телеграма як підказку — людина може змінити.
  var u = tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (u) f('name').value = [u.first_name, u.last_name].filter(Boolean).join(' ');

  // Дата не раніше сьогодні.
  var today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  f('payDate').min = today.toISOString().slice(0, 10);

  function values() {
    var cur = form.querySelector('input[name="currency"]:checked');
    return {
      name: f('name').value.trim(),
      payDate: f('payDate').value,
      purpose: f('purpose').value.trim(),
      amount: f('amount').value.replace(/\s/g, '').replace(',', '.'),
      currency: cur ? cur.value : '',
      requisites: f('requisites').value.trim(),
    };
  }

  function isValid(v) {
    var amount = Number(v.amount);
    return v.name && /^\d{4}-\d{2}-\d{2}$/.test(v.payDate) && v.purpose &&
      v.amount !== '' && isFinite(amount) && amount > 0 && v.currency && v.requisites;
  }

  function refresh() {
    submit.disabled = !isValid(values());
  }
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  refresh();

  var sending = false;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = values();
    if (sending || !isValid(v)) return;
    sending = true;
    submit.disabled = true;
    submit.textContent = 'Надсилаємо…';
    errorBox.hidden = true;

    if (viaKeyboard) {
      var payload = JSON.stringify(v);
      // Телеграм приймає до 4096 байт; кирилиця — 2 байти на літеру.
      if (new TextEncoder().encode(payload).length > 4000) {
        errorBox.textContent = 'Задовгий текст. Скоротіть «За що оплата» або реквізити.';
        errorBox.hidden = false;
        sending = false;
        submit.textContent = 'Надіслати';
        refresh();
        return;
      }
      tg.sendData(payload); // анкета закриється, код запиту бот пришле в чат
      return;
    }

    // text/plain — без CORS-preflight, якого Apps Script не обробляє.
    fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ initData: tg.initData, form: v }),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Помилка');
        form.hidden = true;
        document.getElementById('code').textContent = res.code;
        document.getElementById('done').hidden = false;
        tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('success');
      })
      .catch(function (err) {
        errorBox.textContent = err && err.message && err.message !== 'Failed to fetch'
          ? err.message : 'Немає зв\'язку. Перевірте інтернет і спробуйте ще раз.';
        errorBox.hidden = false;
        sending = false;
        submit.textContent = 'Надіслати';
        refresh();
      });
  });

  document.getElementById('close').addEventListener('click', function () { tg.close(); });
})();
