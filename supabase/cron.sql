-- =====================================================================
--  Расписание рассылки напоминаний (раз в 15 минут)
--  Перед запуском: Database → Extensions → включить pg_cron и pg_net.
--  Подставьте адрес проекта и ТОТ ЖЕ секрет, что вы записали в Secrets как CRON_SECRET.
-- =====================================================================
select cron.schedule(
  'kbju-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://ВАШ-ПРОЕКТ.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'ВАШ-CRON-СЕКРЕТ'),
    body    := '{}'::jsonb
  );
  $$
);

-- Остановить рассылку:        select cron.unschedule('kbju-reminders');
-- Посмотреть, как отработало: select * from cron.job_run_details order by start_time desc limit 10;
