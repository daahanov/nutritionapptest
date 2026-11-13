/* КБЖУ — подключение к Supabase.
 *
 * Приложение общается с «облаком» через два объекта: db (документы) и user (аккаунт).
 * Внутри Claude их выдаёт платформа, на своём хостинге — этот файл, поверх Supabase.
 * Остальной код приложения об этом ничего не знает.
 *
 * Документы лежат в таблице public.docs (path + data), правила доступа — в supabase/schema.sql.
 */
(function (root) {
  'use strict';

  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
    return o;
  }
  function rid() { return Math.random().toString(36).slice(2, 10); }

  // Ошибки приводим к виду { code, message }: код permission_denied — «нет прав»
  function mapError(e) {
    if (!e) return new Error('неизвестная ошибка');
    var msg = e.message || String(e), code = e.code;
    if (code === '42501' || /row-level security|permission denied/i.test(msg)) code = 'permission_denied';
    var err = new Error(msg); err.code = code; err.original = e;
    return err;
  }

  function create(sb, opts) {
    opts = opts || {};
    var SRC = opts.srcId || rid();          // метка этой вкладки: свои же записи не применяем повторно
    var session = null;
    var staffCache = null;

    // ---------- снимки документов ----------
    function snapOf(path, row, forceNotMine) {
      var exists = !!row, data, mine = false;
      if (exists) {
        data = clone(row.data || {});
        if (data._src) { mine = data._src === SRC; delete data._src; }
      }
      return {
        id: path.split('/').pop(), exists: exists,
        data: function () { return exists ? deepFreeze(clone(data)) : undefined; },
        metadata: { hasPendingWrites: forceNotMine ? false : mine, fromCache: false }
      };
    }
    function ts(row) { return row && row.updated_at ? Date.parse(row.updated_at) || 0 : 0; }

    // ---------- документ ----------
    function doc(path) {
      var ref = {
        get: async function () {
          var r = await sb.from('docs').select('path,data,updated_at').eq('path', path).maybeSingle();
          if (r.error) throw mapError(r.error);
          return snapOf(path, r.data, true);
        },
        set: async function (data) {
          var body = clone(data); body._src = SRC;
          var r = await sb.from('docs').upsert({ path: path, data: body }, { onConflict: 'path' });
          if (r.error) throw mapError(r.error);
        },
        update: async function (patch) {
          var p = clone(patch); p._src = SRC;
          var r = await sb.rpc('doc_merge', { p_path: path, p_patch: p });
          if (r.error) throw mapError(r.error);
          if (!r.data) { var e = new Error('документ не найден или нет прав на его изменение'); e.code = 'not_found'; throw e; }
        },
        delete: async function () {
          var r = await sb.from('docs').delete().eq('path', path);
          if (r.error) throw mapError(r.error);
        },
        onSnapshot: function (cb, errCb) {
          var closed = false, lastTs = 0;
          var emit = function (row, notMine) {
            if (closed) return;
            var t = ts(row);
            if (row && t && t < lastTs) return;   // более старое состояние не показываем
            if (t) lastTs = t;
            cb(snapOf(path, row, notMine));
          };
          var refresh = function () {
            ref.get().then(function (s) { if (!closed) cb(s); }).catch(function (e) { if (!closed && errCb) errCb(mapError(e)); });
          };
          var ch = sb.channel('doc-' + rid())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'path=eq.' + path }, function (p) {
              if (p.eventType === 'DELETE') emit(null, true);
              else emit({ path: path, data: p.new && p.new.data, updated_at: p.new && p.new.updated_at }, false);
            })
            .subscribe(function (status) {
              if (status === 'SUBSCRIBED') refresh();                       // после (пере)подключения — свежее состояние
              else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && errCb && !closed) errCb(mapError({ code: 'realtime', message: 'нет связи с сервером реального времени' }));
            });
          refresh();
          return function () { closed = true; try { sb.removeChannel(ch); } catch (e) { /* уже закрыт */ } };
        }
      };
      return ref;
    }

    // ---------- коллекция ----------
    async function runQuery(col, filters) {
      var q = sb.from('docs').select('path,data,updated_at').eq('col', col).order('path');
      filters.forEach(function (f) { q = f[1] === null ? q.is('data->>' + f[0], null) : q.eq('data->>' + f[0], String(f[1])); });
      var r = await q;
      if (r.error) throw mapError(r.error);
      var docs = (r.data || []).map(function (row) { return snapOf(row.path, row, true); });
      return { docs: docs, size: docs.length, empty: !docs.length, metadata: { hasPendingWrites: false }, docChanges: function () { return []; } };
    }
    function makeQuery(col, filters) {
      return {
        where: function (field, op, value) {
          if (op !== '==') throw new Error('поддерживается только оператор ==');
          return makeQuery(col, filters.concat([[field, value]]));
        },
        get: function () { return runQuery(col, filters); },
        onSnapshot: function (cb, errCb) {
          var closed = false, timer = null;
          var refresh = function () {
            runQuery(col, filters).then(function (s) { if (!closed) cb(s); }).catch(function (e) { if (!closed && errCb) errCb(mapError(e)); });
          };
          var ch = sb.channel('col-' + rid())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'col=eq.' + col }, function () {
              clearTimeout(timer); timer = setTimeout(refresh, 60);      // пачку изменений собираем в один пересчёт
            })
            .subscribe(function (status) {
              if (status === 'SUBSCRIBED') refresh();
              else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && errCb && !closed) errCb(mapError({ code: 'realtime', message: 'нет связи с сервером реального времени' }));
            });
          refresh();
          return function () { closed = true; clearTimeout(timer); try { sb.removeChannel(ch); } catch (e) { /* уже закрыт */ } };
        }
      };
    }

    var db = {
      kind: 'supabase',
      doc: doc,
      collection: function (col) { return makeQuery(col, []); },
      // серверные функции (вход по коду приглашения)
      rpc: async function (name, args) {
        var r = await sb.rpc(name, args || {});
        if (r.error) throw mapError(r.error);
        return r.data;
      }
    };

    // ---------- аккаунт ----------
    function uid() { return session && session.user ? session.user.id : null; }
    async function staffRow() {
      var id = uid(); if (!id) return null;
      if (staffCache && staffCache.id === id) return staffCache.row;
      var r = await sb.from('staff').select('role').eq('uid', id).maybeSingle();
      var row = r.error ? null : r.data;
      staffCache = { id: id, row: row };
      return row;
    }
    function niceName(u) {
      if (!u) return '';
      var m = u.user_metadata || {};
      return m.name || (u.email ? u.email.split('@')[0] : '');
    }
    var user = {
      kind: 'supabase',
      id: async function () { return uid(); },
      me: async function () { var u = session && session.user; return { id: uid(), name: niceName(u), email: u ? u.email : '', canEdit: !!u }; },
      name: async function () { return niceName(session && session.user); },
      can: async function () { return !!uid(); },                       // реальные права проверяет сервер
      isOwner: async function () { var r = await staffRow(); return !!(r && r.role === 'admin'); },
      isStaff: async function () { return !!(await staffRow()); },
      profiles: async function (ids) { var o = {}; if (uid() && (ids || []).indexOf(uid()) > -1) o[uid()] = { name: niceName(session.user) }; return o; },
      search: async function () { return []; }
    };

    // вызов серверной функции Supabase (Edge Function), например отправка уведомления
    async function callFunction(name, body) {
      var r = await sb.functions.invoke(name, { body: body || {} });
      if (r.error) {
        var msg = r.error.message || 'ошибка', ctx = r.error.context;
        try { if (ctx && typeof ctx.json === 'function') { var j = await ctx.json(); if (j && (j.error || j.message)) msg = j.error || j.message; } } catch (e) { /* ответ не JSON */ }
        var err = new Error(msg); err.code = r.error.name; throw err;
      }
      return r.data;
    }

    return {
      kind: 'supabase', db: db, user: user, SRC: SRC, callFunction: callFunction,
      setSession: function (s) { session = s; staffCache = null; },
      getSession: function () { return session; }
    };
  }

  // ====================== в браузере: клиент, вход, подключение к приложению ======================
  var AUTH_TEXT = {
    'Invalid login credentials': 'Неверная почта или пароль',
    'User already registered': 'Такой аккаунт уже есть — нажмите «Войти»',
    'Email not confirmed': 'Почта не подтверждена: найдите письмо от Supabase и перейдите по ссылке',
    'Signup requires a valid password': 'Введите пароль',
    'Unable to validate email address: invalid format': 'Проверьте адрес почты',
    'email rate limit exceeded': 'Слишком много писем за короткое время — подождите немного и повторите',
    'over_email_send_rate_limit': 'Слишком много писем за короткое время — подождите немного и повторите'
  };
  function authMsg(e) {
    var m = (e && (e.message || e.msg)) || 'ошибка';
    if (AUTH_TEXT[m]) return AUTH_TEXT[m];
    if (/at least 6/i.test(m)) return 'Пароль — не короче 6 символов';
    if (/rate limit/i.test(m)) return AUTH_TEXT['email rate limit exceeded'];
    if (/failed to fetch|network/i.test(m)) return 'Нет связи с сервером. Проверьте интернет';
    return m;
  }

  function loginUI(sb, onDone) {
    var el = document.createElement('div');
    el.id = 'auth-gate';
    el.style.cssText = 'position:fixed;inset:0;z-index:300;background:var(--bg,#fff);display:none;align-items:center;justify-content:center;padding:24px;overflow:auto;';
    el.innerHTML =
      '<div style="max-width:320px;width:100%;">' +
      '<p style="font-size:18px;font-weight:700;margin:0 0 4px;text-align:center;">КБЖУ</p>' +
      '<p id="au-sub" style="font-size:12px;color:var(--muted,#888);margin:0 0 16px;text-align:center;">Вход в приложение</p>' +
      '<div id="au-name-wrap" style="display:none;"><label class="np-label" style="margin-top:0;">Ваше имя</label><input id="au-name" class="np-input" autocomplete="name" placeholder="Как к вам обращаться"></div>' +
      '<label class="np-label" style="margin-top:0;">Почта</label><input id="au-email" class="np-input" type="email" autocomplete="email" inputmode="email" placeholder="name@example.com">' +
      '<div id="au-pass-wrap"><label class="np-label">Пароль</label><input id="au-pass" class="np-input" type="password" autocomplete="current-password" placeholder="не короче 6 символов"></div>' +
      '<p id="au-msg" class="hint" style="padding:6px 0 0;min-height:18px;"></p>' +
      '<div style="display:flex;flex-direction:column;gap:8px;margin-top:6px;">' +
      '<button id="au-main" class="modal-btn primary" style="padding:13px;">Войти</button>' +
      '<button id="au-switch" class="modal-btn" style="padding:13px;">Создать аккаунт</button>' +
      '<button id="au-forgot" style="background:none;border:none;color:var(--accent,#0a7);font-size:12.5px;cursor:pointer;padding:6px;">Забыли пароль?</button>' +
      '</div></div>';
    document.body.appendChild(el);
    var $ = function (id) { return el.querySelector('#' + id); };
    var mode = 'signin';   // signin | signup | recovery
    function say(t, bad) { var m = $('au-msg'); m.textContent = t || ''; m.style.color = bad ? 'var(--over,#d33)' : 'var(--text2,#555)'; }
    function setMode(m) {
      mode = m; say('');
      $('au-name-wrap').style.display = m === 'signup' ? 'block' : 'none';
      $('au-pass-wrap').style.display = 'block';
      $('au-pass').setAttribute('autocomplete', m === 'signin' ? 'current-password' : 'new-password');
      $('au-forgot').style.display = m === 'signin' ? 'inline' : 'none';
      $('au-email').parentNode.style.display = '';
      if (m === 'signin') { $('au-sub').textContent = 'Вход в приложение'; $('au-main').textContent = 'Войти'; $('au-switch').textContent = 'Создать аккаунт'; $('au-switch').style.display = ''; }
      if (m === 'signup') { $('au-sub').textContent = 'Новый аккаунт'; $('au-main').textContent = 'Создать аккаунт'; $('au-switch').textContent = 'У меня уже есть аккаунт'; $('au-switch').style.display = ''; }
      if (m === 'recovery') {
        $('au-sub').textContent = 'Придумайте новый пароль'; $('au-main').textContent = 'Сохранить пароль'; $('au-switch').style.display = 'none';
        $('au-forgot').style.display = 'none'; $('au-email').parentNode.style.display = 'none'; $('au-pass').setAttribute('autocomplete', 'new-password');
      }
    }
    async function submit() {
      var email = $('au-email').value.trim(), pass = $('au-pass').value, btn = $('au-main');
      btn.disabled = true; say('');
      try {
        if (mode === 'recovery') {
          if (pass.length < 6) { say('Пароль — не короче 6 символов', true); return; }
          var u = await sb.auth.updateUser({ password: pass }); if (u.error) throw u.error;
          say('Пароль сохранён'); finish(); return;
        }
        if (!email) { say('Введите почту', true); return; }
        if (!pass) { say('Введите пароль', true); return; }
        if (mode === 'signup') {
          var name = $('au-name').value.trim();
          if (!name) { say('Введите имя', true); return; }
          var r = await sb.auth.signUp({ email: email, password: pass, options: { data: { name: name } } });
          if (r.error) throw r.error;
          if (!r.data.session) { setMode('signin'); $('au-email').value = email; say('Мы отправили письмо — подтвердите почту по ссылке, затем войдите'); return; }
        } else {
          var s = await sb.auth.signInWithPassword({ email: email, password: pass });
          if (s.error) throw s.error;
        }
        // дальше сработает onAuthStateChange
      } catch (e) { say(authMsg(e), true); }
      finally { btn.disabled = false; }
    }
    function finish() { el.style.display = 'none'; onDone(); }
    $('au-main').onclick = submit;
    $('au-switch').onclick = function () { setMode(mode === 'signin' ? 'signup' : 'signin'); };
    $('au-forgot').onclick = async function () {
      var email = $('au-email').value.trim();
      if (!email) { say('Сначала введите почту, на неё придёт ссылка для нового пароля', true); return; }
      try {
        var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        if (r.error) throw r.error;
        say('Если такой аккаунт есть, мы отправили письмо со ссылкой для нового пароля');
      } catch (e) { say(authMsg(e), true); }
    };
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); });
    return { show: function (m) { el.style.display = 'flex'; setMode(m || 'signin'); }, hide: function () { el.style.display = 'none'; } };
  }

  function showFatal(text) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:400;background:#fff;color:#222;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font:14px system-ui,sans-serif;';
    d.innerHTML = '<div style="max-width:340px;"><p style="font-size:16px;font-weight:700;margin:0 0 8px;">Приложение не настроено</p><p style="margin:0;color:#555;">' + text + '</p></div>';
    document.body.appendChild(d);
  }

  function boot() {
    var cfg = root.APP_CONFIG;
    if (!cfg) return;                                           // внутри Claude конфигурации нет — ничего не подключаем
    if (!root.supabase || !root.supabase.createClient) { showFatal('Не загрузилась библиотека supabase.js (папка vendor).'); return; }
    if (!cfg.supabaseUrl || /ВАШ|YOUR|xxxx/i.test(cfg.supabaseUrl) || !cfg.supabaseAnonKey || /ВАШ|YOUR/i.test(cfg.supabaseAnonKey)) {
      showFatal('Откройте файл config.js и впишите адрес проекта Supabase и ключ anon. Подробности — в инструкции.'); return;
    }
    var sb = root.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    var be = create(sb);
    var ui = null, waiting = [];
    function lastUserGuard(s) {  // на общем устройстве данные прежнего пользователя не должны достаться новому
      try {
        var K = 'kbju_last_uid_v1', prev = localStorage.getItem(K), now = s && s.user ? s.user.id : null;
        if (now && prev && prev !== now) { ['kbju_demo_state_v1', 'kbju_role_local_v2', 'kbju_admin_view_v1'].forEach(function (k) { localStorage.removeItem(k); }); }
        if (now) localStorage.setItem(K, now);
      } catch (e) { /* хранилище недоступно */ }
    }
    sb.auth.onAuthStateChange(function (evt, s) {
      be.setSession(s);
      if (evt === 'PASSWORD_RECOVERY') { ui = ui || loginUI(sb, function () {}); ui.show('recovery'); }
      if (evt === 'SIGNED_OUT') { try { location.reload(); } catch (e) { /* */ } }
    });
    function ensureAuth() {
      return sb.auth.getSession().then(function (r) {
        var s = r.data && r.data.session;
        if (s) { be.setSession(s); lastUserGuard(s); return s; }
        return new Promise(function (resolve) {
          ui = ui || loginUI(sb, function () {});
          ui.show('signin');
          sb.auth.onAuthStateChange(function (evt, s2) {
            if (s2 && evt !== 'PASSWORD_RECOVERY' && waiting.indexOf(resolve) === -1) {
              waiting.push(resolve); be.setSession(s2); lastUserGuard(s2); ui.hide(); resolve(s2);
            }
          });
        });
      });
    }
    root.BACKEND = {
      kind: 'supabase', db: be.db, user: be.user, ensureAuth: ensureAuth, callFunction: be.callFunction, vapidPublicKey: String(cfg.vapidPublicKey || ''),
      signOut: function () { return sb.auth.signOut().then(function () { try { ['kbju_demo_state_v1', 'kbju_role_local_v2', 'kbju_admin_view_v1', 'kbju_last_uid_v1'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { /* */ } location.reload(); }); }
    };
    // приложение ждёт объект window.claude с возможностями db и user — отдаём ему наши
    root.claude = { use: function (name) { return Promise.resolve(name === 'db' ? be.db : name === 'user' ? be.user : null); } };
  }

  var api = { create: create, mapError: mapError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.KbjuBackend = api; boot(); }
})(typeof window !== 'undefined' ? window : globalThis);
