-- =====================================================================
--  КБЖУ-приложение: схема базы данных для Supabase
--  Выполните ЦЕЛИКОМ в Supabase: SQL Editor → New query → вставить → Run.
--  Скрипт можно запускать повторно: он ничего не ломает и не стирает данные.
-- =====================================================================

-- ---------- 1. Хранилище документов ----------
-- Все данные приложения лежат в одной таблице «документов» (путь + JSON).
-- Пути: roles/<uid>, clientsMeta/<id>, clients/<id>, invites/<код>, shared/base
create table if not exists public.docs (
  path        text primary key,
  col         text generated always as (split_part(path, '/', 1)) stored,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
create index if not exists docs_col_idx on public.docs (col);
alter table public.docs replica identity full;   -- нужно, чтобы удаления доходили до подписчиков в реальном времени

-- ---------- 2. Сотрудники: администратор и тренер ----------
-- Кто здесь записан, тот видит и меняет всё. Клиенты сюда не попадают.
create table if not exists public.staff (
  uid   uuid primary key references auth.users (id) on delete cascade,
  role  text not null check (role in ('admin', 'coach'))
);

alter table public.docs  enable row level security;
alter table public.staff enable row level security;

-- ---------- 3. Вспомогательные функции для правил доступа ----------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where uid = auth.uid());
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where uid = auth.uid() and role = 'admin');
$$;

-- «Это мой профиль клиента?»: в карточке клиента записан мой аккаунт
create or replace function public.client_of(cid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.docs
    where path = 'clientsMeta/' || cid and data ->> 'uid' = auth.uid()::text
  );
$$;

-- ---------- 4. Правила доступа ----------
drop policy if exists docs_select       on public.docs;
drop policy if exists docs_write_staff  on public.docs;
drop policy if exists docs_write_client on public.docs;
drop policy if exists staff_self_select on public.staff;

-- читать: сотрудники — всё; все вошедшие — общую базу продуктов;
--         каждый — свою запись роли; клиент — свою карточку и свои данные
create policy docs_select on public.docs for select to authenticated using (
     public.is_staff()
  or col = 'shared'
  or (col = 'roles' and path = 'roles/' || auth.uid()::text)
  or (col in ('clients', 'clientsMeta') and public.client_of(split_part(path, '/', 2)))
);

-- писать: сотрудники — всё
create policy docs_write_staff on public.docs for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- писать: клиент — только свои данные (дневник, продукты) в clients/<его id>
create policy docs_write_client on public.docs for all to authenticated
  using      (col = 'clients' and public.client_of(split_part(path, '/', 2)))
  with check (col = 'clients' and public.client_of(split_part(path, '/', 2)));

-- сотрудник может увидеть свою строку в таблице staff (так приложение узнаёт, что вы тренер/админ)
create policy staff_self_select on public.staff for select to authenticated using (uid = auth.uid());

-- ---------- 5. Время последнего изменения ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
  for each row execute function public.touch_updated_at();

-- ---------- 6. Слияние полей документа (используется приложением) ----------
-- Работает с правами вызывающего, поэтому правила доступа действуют и здесь.
create or replace function public.doc_merge(p_path text, p_patch jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  update public.docs set data = data || p_patch where path = p_path;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- 7. Вход клиента по коду приглашения ----------
-- Клиент не может напрямую менять чужие записи, поэтому весь вход проходит здесь,
-- под строгой проверкой: код существует, не отозван, не использован другим аккаунтом.
create or replace function public.accept_invite(p_code text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := auth.uid();
  code   text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  nm     text := left(btrim(coalesce(p_name, '')), 80);
  inv    jsonb;
  meta   jsonb;
  cid    text;
  old    text;
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if me is null then raise exception 'not_authenticated'; end if;
  if length(code) < 6 then raise exception 'invite_not_found'; end if;
  if nm = '' then raise exception 'name_required'; end if;

  select data into inv from public.docs where path = 'invites/' || code;
  if inv is null then raise exception 'invite_not_found'; end if;
  if coalesce((inv ->> 'revoked')::boolean, false) then raise exception 'invite_revoked'; end if;
  if coalesce((inv ->> 'used')::boolean, false) and (inv ->> 'usedBy') is distinct from me::text then
    raise exception 'invite_used';
  end if;

  cid := inv ->> 'clientId';
  select data into meta from public.docs where path = 'clientsMeta/' || cid;
  if meta is null then raise exception 'client_not_found'; end if;

  -- прежний аккаунт этого клиента отвязываем
  old := meta ->> 'uid';
  if old is not null and old <> me::text then
    delete from public.docs where path = 'roles/' || old;
  end if;

  update public.docs
     set data = data || jsonb_build_object('used', true, 'usedBy', me::text, 'usedAt', now_ms, 'name', nm)
   where path = 'invites/' || code;

  update public.docs
     set data = (data - 'pendingCode')
                || jsonb_build_object('uid', me::text, 'name', nm, 'status', 'active', 'acceptedAt', now_ms)
   where path = 'clientsMeta/' || cid;

  insert into public.docs (path, data)
  values ('roles/' || me::text, jsonb_build_object('role', 'client', 'clientId', cid, 'coachUid', inv ->> 'coachUid'))
  on conflict (path) do update set data = excluded.data;

  return jsonb_build_object('clientId', cid, 'coachUid', inv ->> 'coachUid');
end $$;

-- ---------- 8. Права на вызов ----------
revoke all on public.docs  from anon;
revoke all on public.staff from anon;
grant select, insert, update, delete on public.docs  to authenticated;
grant select                         on public.staff to authenticated;

revoke all on function public.doc_merge(text, jsonb)     from public, anon;
revoke all on function public.accept_invite(text, text)  from public, anon;
grant execute on function public.doc_merge(text, jsonb)    to authenticated;
grant execute on function public.accept_invite(text, text) to authenticated;
grant execute on function public.is_staff()  to authenticated;
grant execute on function public.is_admin()  to authenticated;
grant execute on function public.client_of(text) to authenticated;

-- ---------- 9. Изменения в реальном времени ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs'
  ) then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
