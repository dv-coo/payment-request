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
  // На телефоні — на весь екран: без шапки Телеграма з назвою бота.
  var mobile = tg.platform === 'ios' || tg.platform === 'android';
  var v8 = tg.isVersionAtLeast && tg.isVersionAtLeast('8.0');
  if (mobile && v8 && tg.requestFullscreen) {
    try { tg.requestFullscreen(); } catch (e) { /* стара версія Телеграма — лишається звичайний вигляд */ }
  }
  // Щоб прокрутка анкети вниз не закривала її випадково.
  if (tg.disableVerticalSwipes && tg.isVersionAtLeast && tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes();
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
    var ok = isValid(values());
    submit.disabled = !ok;
    kbSend.hidden = !ok;
  }

  /* --------- Клавіатура на телефоні: поле над клавіатурою, панель «Готово / Далі / Надіслати» --------- */
  var ORDER = ['name', 'payDate', 'purpose', 'amount', 'requisites'];
  var kbar = document.getElementById('kbar');
  var kbNext = document.getElementById('kbNext');
  var kbSend = document.getElementById('kbSend');
  var current = null;

  function placeBar() {
    var vv = window.visualViewport;
    var offset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    kbar.style.bottom = offset + 'px';
  }
  function showCurrent() {
    if (!current) return;
    placeBar();
    current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', showCurrent);
    window.visualViewport.addEventListener('scroll', placeBar);
  }
  tg.onEvent && tg.onEvent('viewportChanged', showCurrent);

  form.addEventListener('focusin', function (e) {
    var i = ORDER.indexOf(e.target.name);
    if (i === -1) return;
    current = e.target;
    kbNext.hidden = i === ORDER.length - 1;
    kbar.hidden = false;
    document.body.classList.add('kb-open');
    setTimeout(showCurrent, 350); // після того, як клавіатура виїхала
  });
  form.addEventListener('focusout', function () {
    setTimeout(function () {
      if (ORDER.indexOf(document.activeElement && document.activeElement.name) !== -1) return;
      current = null;
      kbar.hidden = true;
      document.body.classList.remove('kb-open');
    }, 120);
  });
  // Натискання на панель не має забирати фокус з поля, інакше клавіатура сховається.
  kbar.addEventListener('pointerdown', function (e) { e.preventDefault(); });
  function goNext() {
    var i = current ? ORDER.indexOf(current.name) : -1;
    if (i !== -1 && i < ORDER.length - 1) f(ORDER[i + 1]).focus();
    else if (current) current.blur();
  }
  kbNext.addEventListener('click', goNext);
  document.getElementById('kbDone').addEventListener('click', function () { if (current) current.blur(); });
  kbSend.addEventListener('click', function () {
    if (current) current.blur();
    submit.click();
  });
  // «Далі» на самій клавіатурі для однорядкових полів.
  ['name', 'amount'].forEach(function (n) {
    f(n).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); goNext(); }
    });
  });
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
