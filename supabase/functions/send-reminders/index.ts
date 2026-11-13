// КБЖУ: рассылка напоминаний о замерах (Supabase Edge Function).
//
// Вызывается двумя способами:
//   1) по расписанию (pg_cron, раз в 15 минут) с секретом в заголовке x-cron-secret:
//      накануне замеров, в 20:00 по времени устройства клиента, отправляет напоминание;
//   2) из приложения (тренер или клиент) с телом {"test": "<id клиента>"}: тестовое уведомление.
//
// Секреты (Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET.
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY платформа подставляет сама.
// Функцию нужно развернуть с выключенной проверкой JWT (Verify JWT = off): доступ проверяется внутри.

const DEFAULT_TZ = 'Europe/Moscow';
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------- даты (в UTC, чтобы переход на летнее время ничего не сдвигал) ----------
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function isoOf(dt) { return dt.toISOString().slice(0, 10); }
export function addDays(iso, n) { const d = parseISO(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); }
export function daysBetween(a, b) { return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / 86400000); }

// ---------- график замеров: дни замеров = дата первых замеров + k * every ----------
export function nextDueAfter(sched, iso) {
  if (!sched || ![7, 14].includes(sched.every) || !ISO_RE.test(sched.anchor || '')) return null;
  if (sched.anchor > iso) return sched.anchor;
  return addDays(sched.anchor, (Math.floor(daysBetween(sched.anchor, iso) / sched.every) + 1) * sched.every);
}
// Дата замеров, о которых нужно напомнить сегодняшним вечером (то есть завтра), или null.
// Если клиент уже измерился (в том числе на день раньше), напоминать не нужно.
export function eveningDue(sched, measureDates, localDate) {
  const next = nextDueAfter(sched, localDate);
  if (!next || next !== addDays(localDate, 1)) return null;
  if (measureDates.some((d) => d >= addDays(next, -1))) return null;
  return next;
}
// Местная дата и час в заданном часовом поясе.
export function localParts(nowMs, tz) {
  let f;
  try {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch (_) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  const p = Object.fromEntries(f.formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

const REMINDER = {
  title: 'Завтра утром замеры',
  body: 'Утром, натощак: вес, шея, грудь, талия 1 и 2, бёдра. Внесите их в приложении.',
  tag: 'kbju-measure',
  url: './#measures',
};
const TEST = {
  title: 'КБЖУ: тестовое уведомление',
  body: 'Если вы это видите, уведомления работают.',
  tag: 'kbju-test',
  url: './#measures',
};

async function sendToClient(admin, webpush, clientId, payload) {
  const res = await admin.from('docs').select('data').eq('path', 'push/' + clientId).maybeSingle();
  const doc = (res.data && res.data.data) || {};
  const subs = Array.isArray(doc.subs) ? doc.subs : [];
  const out = { subs: subs.length, sent: 0, failed: 0, removed: 0, errors: [] };
  const keep = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 10800, urgency: 'high' });
      out.sent++; keep.push(s);
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) out.removed++;           // подписка больше не действует
      else { out.failed++; out.errors.push(String(code || (e && e.message) || e)); keep.push(s); }
    }
  }
  if (out.removed) await admin.from('docs').upsert({ path: 'push/' + clientId, data: { ...doc, subs: keep } }, { onConflict: 'path' });
  return out;
}

async function mayTest(admin, caller, clientId) {
  const st = await admin.from('staff').select('role').eq('uid', caller.id).maybeSingle();
  if (st.data) return true;
  const meta = await admin.from('docs').select('data').eq('path', 'clientsMeta/' + clientId).maybeSingle();
  return !!(meta.data && meta.data.data && meta.data.data.uid === caller.id);
}

export async function handle(req, deps) {
  const { createClient, webpush, env } = deps;
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return json({ error: 'не заданы ключи VAPID (Edge Functions → Secrets)' }, 500);

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const cronOk = !!env.CRON_SECRET && req.headers.get('x-cron-secret') === env.CRON_SECRET;
  let caller = null;
  if (!cronOk) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'нет авторизации' }, 401);
    const got = await admin.auth.getUser(token);
    if (got.error || !got.data || !got.data.user) return json({ error: 'сессия недействительна: войдите в приложение заново' }, 401);
    caller = got.data.user;
  }
  let body = {};
  try { body = await req.json(); } catch (_) { /* пустое тело — обычный запуск по расписанию */ }
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  // ---------- тестовое уведомление ----------
  if (body && body.test) {
    const clientId = String(body.test);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) return json({ error: 'некорректный идентификатор клиента' }, 400);
    if (caller && !(await mayTest(admin, caller, clientId))) return json({ error: 'нет прав отправлять уведомление этому клиенту' }, 403);
    return json({ mode: 'test', ...(await sendToClient(admin, webpush, clientId, TEST)) });
  }

  // ---------- рассылка по расписанию: только cron или сотрудник ----------
  if (!cronOk) {
    const st = await admin.from('staff').select('role').eq('uid', caller.id).maybeSingle();
    if (!st.data) return json({ error: 'запуск рассылки доступен только расписанию и сотрудникам' }, 403);
  }
  const hour = Number(env.REMINDER_HOUR || 20);
  const stats = { mode: 'cron', checked: 0, skipped: 0, noSubs: 0, notDue: 0, already: 0, sent: 0, failed: 0, removed: 0 };
  const rows = await admin.from('docs').select('path, measureSchedule:data->measureSchedule, measures:data->MEASURES').eq('col', 'clients');
  for (const row of (rows.data || [])) {
    stats.checked++;
    const clientId = String(row.path).split('/')[1];
    const sched = row.measureSchedule;
    if (!sched || ![7, 14].includes(sched.every) || !ISO_RE.test(sched.anchor || '')) { stats.skipped++; continue; }
    const dates = (Array.isArray(row.measures) ? row.measures : []).map((m) => m && m.date).filter((d) => ISO_RE.test(d || ''));
    const pushRes = await admin.from('docs').select('data').eq('path', 'push/' + clientId).maybeSingle();
    const subs = (pushRes.data && pushRes.data.data && pushRes.data.data.subs) || [];
    if (!subs.length) { stats.noSubs++; continue; }
    let due = null;
    for (const s of subs) {                      // вечерний час считаем по часовому поясу устройства
      const lp = localParts(nowMs, s.tz || DEFAULT_TZ);
      if (lp.hour === hour) { due = eveningDue(sched, dates, lp.date); if (due) break; }
    }
    if (!due) { stats.notDue++; continue; }
    const logRes = await admin.from('docs').select('data').eq('path', 'pushLog/' + clientId).maybeSingle();
    const log = (logRes.data && logRes.data.data) || { notified: {} };
    if (log.notified && log.notified[due]) { stats.already++; continue; }  // об этой дате уже напоминали
    const r = await sendToClient(admin, webpush, clientId, REMINDER);
    stats.sent += r.sent; stats.failed += r.failed; stats.removed += r.removed;
    if (r.sent > 0) {
      const notified = { ...(log.notified || {}), [due]: nowMs };
      const keys = Object.keys(notified).sort().slice(-10);
      await admin.from('docs').upsert({ path: 'pushLog/' + clientId, data: { notified: Object.fromEntries(keys.map((k) => [k, notified[k]])) } }, { onConflict: 'path' });
    }
  }
  return json(stats);
}

// ---------- запуск в Supabase (Deno) ----------
if (typeof Deno !== 'undefined' && Deno.serve) {
  Deno.serve(async (req) => {
    const [{ default: webpush }, { createClient }] = await Promise.all([import('npm:web-push@3.6.7'), import('npm:@supabase/supabase-js@2')]);
    return handle(req, { createClient, webpush, env: Deno.env.toObject() });
  });
}
