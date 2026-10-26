КБЖУ — запуск на своём хостинге (Supabase)
==========================================

В папке:
  index.html            приложение
  config.js             ВАШИ настройки подключения (заполнить!)
  backend-supabase.js   связь приложения с Supabase
  vendor/supabase.js    библиотека Supabase
  supabase/schema.sql   таблицы и правила доступа — выполнить в Supabase
  manifest.webmanifest, sw.js, icons/   установка на телефон, работа при слабой связи
  .nojekyll, _headers   служебные файлы хостинга (не удалять)

Коротко (подробно — в документе «КБЖУ: запуск на своём хостинге»):
  1. Supabase: New project (регион Frankfurt).
  2. SQL Editor → вставить весь supabase/schema.sql → Run.
  3. Authentication → Providers → Email → выключить Confirm email.
  4. Project Settings → API: Project URL и публичный ключ (anon / publishable) → вписать в config.js.
     Ключ service_role / secret вставлять НЕЛЬЗЯ.
  5. Выложить папку целиком — любой из способов:
     A. GitHub Pages (бесплатно, без рекламных плашек), из этой папки:
          git init -b main
          git add .
          git commit -m "КБЖУ"
          git remote add origin https://github.com/ВАШ_ЛОГИН/kbju.git
          git push -u origin main
        затем на github.com: репозиторий → Settings → Pages → Branch: main, папка / (root) → Save.
        Адрес: https://ВАШ_ЛОГИН.github.io/kbju/
     Б. Российский хостинг: включить HTTPS (Let's Encrypt) и загрузить ВСЁ содержимое папки
        в папку сайта (public_html) через файловый менеджер или FTP.
  6. Проверить БЕЗ VPN, с телефона по мобильному интернету:
       - адрес сайта;
       - https://ВАШ-ПРОЕКТ.supabase.co/auth/v1/health — любой ответ (даже сообщение про ключ)
         значит, что Supabase доступен.
  7. Открыть сайт → «Создать аккаунт». Затем в Supabase SQL Editor:
       insert into public.staff (uid, role)
       select id, 'admin' from auth.users where email = 'ваша@почта.ru';
     Для тренера то же самое с ролью 'coach'. После этого перезагрузить страницу.

Обновление версии: распаковать новую папку, положить в неё ВАШ config.js, выложить заново.
