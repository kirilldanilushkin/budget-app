/* Бюджет — пометки расходов с телефона. Работает без сети: записи копятся в телефоне
   и уходят в Google Таблицу автоматически при появлении связи или по кнопке «Передать». */
(function () {
  'use strict';

  // ---------- хранилище в телефоне ----------
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('pf.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('pf.' + k, JSON.stringify(v)); } catch (e) { toast('Память телефона недоступна'); } }
  };
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  var cfg = LS.get('cfg', {url: '', key: ''});
  var articles = LS.get('articles', window.DEFAULT_ARTICLES);
  var accounts = LS.get('accounts', window.DEFAULT_ACCOUNTS);
  var favorites = LS.get('favorites', window.DEFAULT_FAVORITES);
  var entries = LS.get('entries', []);          // {id, ts, date, amount, account, code, comment, status: pending|sent}

  var state = {sign: -1, account: window.DEFAULT_ACCOUNT, code: null, syncing: false};
  var $ = function (id) { return document.getElementById(id); };

  // ---------- утилиты ----------
  function uid() {
    var a = new Uint8Array(8);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return 'M' + Date.now().toString(36) + '-' + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function today() { var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
  function fmt(n) { return (n > 0 ? '+' : '−') + Math.abs(n).toLocaleString('ru-RU', {maximumFractionDigits: 2}) + ' ₽'; }
  function fmtDate(s) { var p = s.split('-'); return p[2] + '.' + p[1]; }
  function article(code) { for (var i = 0; i < articles.length; i++) if (articles[i].code === code) return articles[i]; return {code: code, name: code, block: ''}; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
  var toastTimer;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2600); }
  function saveEntries() { LS.set('entries', entries); updateBadge(); }
  function pending() { return entries.filter(function (e) { return e.status === 'pending'; }); }
  function parseAmount(s) {
    s = String(s).replace(/\s|₽/g, '').replace(',', '.');
    var m = /^(\d+(?:\.\d{1,2})?)(к|k|т)?$/i.exec(s);       // «500», «1500,50», «50к»
    if (!m) return NaN;
    return Number(m[1]) * (m[2] ? 1000 : 1);
  }

  // ---------- экран ввода ----------
  function renderAccounts() {
    var box = $('accounts'); box.innerHTML = '';
    accounts.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip' + (a.name === state.account ? ' on' : ''); b.textContent = a.name;
      b.onclick = function () { state.account = a.name; renderAccounts(); };
      box.appendChild(b);
    });
  }

  function renderFavorites() {
    var box = $('favorites'); box.innerHTML = '';
    favorites.forEach(function (code) {
      var a = article(code);
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip' + (code === state.code ? ' on' : ''); b.textContent = a.name;
      b.onclick = function () { chooseArticle(code === state.code ? null : code); };
      box.appendChild(b);
    });
    var ch = $('chosenArticle');
    if (state.code && favorites.indexOf(state.code) < 0) { ch.hidden = false; ch.textContent = article(state.code).name; }
    else ch.hidden = true;
  }

  function chooseArticle(code) { state.code = code; renderFavorites(); updateSave(); }

  function updateSave() {
    var ok = parseAmount($('amount').value) > 0 && !!state.code;
    $('saveBtn').disabled = !ok;
  }

  function save() {
    var amount = parseAmount($('amount').value);
    if (!(amount > 0)) { toast('Введи сумму'); return; }
    if (!state.code) { toast('Выбери статью'); return; }
    entries.unshift({
      id: uid(), ts: Date.now(), date: $('date').value || today(),
      amount: Math.round(amount * 100) / 100 * state.sign, account: state.account,
      code: state.code, comment: $('comment').value.trim(), status: 'pending'
    });
    saveEntries();
    $('amount').value = ''; $('comment').value = ''; $('date').value = today();
    state.code = null; state.account = window.DEFAULT_ACCOUNT;
    renderAccounts(); renderFavorites(); updateSave(); renderList();
    toast('Сохранено');
    sync(false);
  }

  // ---------- история ----------
  function renderList() {
    var box = $('list');
    if (!entries.length) { box.innerHTML = '<div class="empty">Пока нет записей</div>'; return; }
    box.innerHTML = entries.slice(0, 200).map(function (e) {
      var a = article(e.code);
      return '<div class="row">' +
        '<div class="st">' + (e.status === 'sent' ? '✓' : '⏳') + '</div>' +
        '<div class="main"><div class="t1">' + esc(a.name) + (e.comment ? ' · ' + esc(e.comment) : '') + '</div>' +
        '<div class="t2">' + fmtDate(e.date) + ' · ' + esc(e.account) + '</div></div>' +
        '<div class="sum' + (e.amount > 0 ? ' plus' : '') + '">' + fmt(e.amount) + '</div>' +
        (e.status === 'pending' ? '<button class="del" type="button" data-del="' + e.id + '">✕</button>' : '') +
        '</div>';
    }).join('');
  }
  $('list').addEventListener('click', function (ev) {
    var id = ev.target.getAttribute('data-del'); if (!id) return;
    if (!confirm('Удалить неотправленную запись?')) return;
    entries = entries.filter(function (e) { return e.id !== id; }); saveEntries(); renderList();
  });

  // ---------- выбор статьи и избранное ----------
  function renderPicker() {
    var q = $('search').value.trim().toLowerCase();
    var html = '', lastBlock = null;
    articles.forEach(function (a) {
      if (q && (a.name + ' ' + a.code + ' ' + a.block).toLowerCase().indexOf(q) < 0) return;
      if (a.block !== lastBlock) { html += '<div class="group">' + esc(a.block) + '</div>'; lastBlock = a.block; }
      var fav = favorites.indexOf(a.code) >= 0;
      html += '<div class="row" data-code="' + a.code + '">' +
        '<button type="button" class="star' + (fav ? ' on' : '') + '" data-star="' + a.code + '">★</button>' +
        '<div class="main"><div class="t1">' + esc(a.name) + '</div><div class="t2">' + a.code + '</div></div></div>';
    });
    $('articleList').innerHTML = html || '<div class="empty">Ничего не найдено</div>';
  }
  $('articleList').addEventListener('click', function (ev) {
    var star = ev.target.getAttribute('data-star');
    if (star) {
      var i = favorites.indexOf(star);
      if (i >= 0) favorites.splice(i, 1); else favorites.push(star);
      LS.set('favorites', favorites); renderPicker(); renderFavorites();
      return;
    }
    var row = ev.target.closest('[data-code]');
    if (row) { chooseArticle(row.getAttribute('data-code')); closePicker(); }
  });
  function openPicker() { $('picker').hidden = false; $('search').value = ''; renderPicker(); }
  function closePicker() { $('picker').hidden = true; }

  // ---------- связь с таблицей ----------
  function updateBadge() {
    var n = pending().length, b = $('pendingBadge');
    b.textContent = n; b.hidden = n === 0;
  }

  function api(method, payload) {
    if (!cfg.url || !cfg.key) return Promise.reject(new Error('Не настроено подключение'));
    var opts = {method: method, redirect: 'follow'};
    var url = cfg.url;
    if (method === 'GET') url += (url.indexOf('?') < 0 ? '?' : '&') + 'key=' + encodeURIComponent(cfg.key) + '&action=' + payload;
    else { opts.headers = {'Content-Type': 'text/plain;charset=utf-8'}; opts.body = JSON.stringify(Object.assign({key: cfg.key}, payload)); }
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('Ответ ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j.ok) throw new Error(j.error === 'key' ? 'Неверный ключ' : 'Ошибка: ' + j.error);
      return j;
    });
  }

  function sync(manual) {
    var list = pending();
    if (state.syncing) return;
    if (!list.length) { if (manual) toast('Всё уже передано'); return; }
    if (!cfg.url || !cfg.key) { if (manual) { toast('Сначала заполни настройки'); showView('settings'); } return; }
    if (!navigator.onLine) { if (manual) toast('Нет связи. Записи сохранены в телефоне'); return; }
    state.syncing = true; $('syncBtn').classList.add('busy'); $('syncText').textContent = 'Передаю…';
    api('POST', {entries: list.slice(0, 100)}).then(function (j) {
      var ok = {}; j.saved.forEach(function (id) { ok[id] = true; });
      entries.forEach(function (e) { if (ok[e.id]) e.status = 'sent'; });
      // храним отправленные 60 дней
      var border = Date.now() - 60 * 864e5;
      entries = entries.filter(function (e) { return e.status === 'pending' || e.ts > border; });
      saveEntries(); renderList();
      if (manual) toast('Передано: ' + j.saved.length);
      if (pending().length && j.saved.length) setTimeout(function () { sync(manual); }, 300);
    }).catch(function (err) {
      if (manual) toast('Не удалось: ' + err.message);
    }).then(function () {
      state.syncing = false; $('syncBtn').classList.remove('busy'); $('syncText').textContent = 'Передать';
    });
  }

  function loadRefs(manual) {
    return api('GET', 'refs').then(function (j) {
      if (j.articles && j.articles.length) { articles = j.articles.map(function (a) { return {code: a.code, name: a.name, block: a.block}; }); LS.set('articles', articles); }
      if (j.accounts && j.accounts.length) { accounts = j.accounts; LS.set('accounts', accounts); }
      renderAccounts(); renderFavorites();
      if (manual) toast('Справочник обновлён: ' + articles.length + ' статей');
      return true;
    }).catch(function (err) { if (manual) toast('Не удалось: ' + err.message); return false; });
  }

  // ---------- навигация и настройки ----------
  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-view') === name); });
    if (name === 'list') renderList();
  }
  document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { showView(b.getAttribute('data-view')); }; });

  document.querySelectorAll('#signSeg button').forEach(function (b) {
    b.onclick = function () {
      state.sign = Number(b.getAttribute('data-sign'));
      document.querySelectorAll('#signSeg button').forEach(function (x) { x.classList.toggle('on', x === b); });
    };
  });

  $('amount').addEventListener('input', updateSave);
  $('saveBtn').onclick = save;
  $('allArticlesBtn').onclick = openPicker;
  $('pickerClose').onclick = closePicker;
  $('search').addEventListener('input', renderPicker);
  $('syncBtn').onclick = function () { sync(true); };

  $('cfgUrl').value = cfg.url; $('cfgKey').value = cfg.key;
  $('cfgSave').onclick = function () {
    cfg = {url: $('cfgUrl').value.trim(), key: $('cfgKey').value.trim()}; LS.set('cfg', cfg);
    $('cfgInfo').textContent = 'Проверяю…';
    loadRefs(false).then(function (ok) {
      $('cfgInfo').textContent = ok ? 'Связь есть, справочник загружен.' : 'Связи нет: проверь адрес и ключ.';
      if (ok) sync(false);
    });
  };
  $('refsBtn').onclick = function () { loadRefs(true); };

  window.addEventListener('online', function () { sync(false); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(false); });
  setInterval(function () { if (!document.hidden) sync(false); }, 60000);

  // ---------- старт ----------
  $('date').value = today();
  renderAccounts(); renderFavorites(); updateSave(); updateBadge(); renderList();
  if (cfg.url && cfg.key) { loadRefs(false); sync(false); } else showView('settings');

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();
