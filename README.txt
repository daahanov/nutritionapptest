КБЖУ — запуск на своём хостинге (Supabase)
==========================================

В папке:
  index.html            приложение
  config.js             ВАШИ настройки подключения (заполнить!)
  backend-supabase.js   связь приложения с Supabase
  vendor/supabase.js    библиотека Supabase
  supabase/schema.sql   таблицы и правила доступа — выполнить в Supabase
  manifest.webmanifest, sw.js, icons/   установка на телефон, работа при слабой связи

Коротко (подробно — в документе «КБЖУ: запуск на своём хостинге»):
  1. Supabase: New project (регион Frankfurt).
  2. SQL Editor → вставить весь supabase/schema.sql → Run.
  3. Authentication → Providers → Email → выключить Confirm email.
  4. Project Settings → API: Project URL и публичный ключ (anon / publishable) → вписать в config.js.
     Ключ service_role / secret вставлять НЕЛЬЗЯ.
  5. Выложить папку целиком:
       Netlify:           перетащить папку на https://app.netlify.com/drop
       Cloudflare Pages:  npm install -g wrangler
                          wrangler login
                          wrangler pages project create kbju --production-branch main
                          wrangler pages deploy . --project-name kbju      (из этой папки)
  6. Открыть сайт → «Создать аккаунт». Затем в Supabase SQL Editor:
       insert into public.staff (uid, role)
       select id, 'admin' from auth.users where email = 'ваша@почта.ru';
     Для тренера то же самое с ролью 'coach'. После этого перезагрузить страницу.

Обновление версии: распаковать новую папку, положить в неё ВАШ config.js, выложить заново.
