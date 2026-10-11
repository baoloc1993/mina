-- Vòng 5 (W5) — siết định dạng ngày/giờ ở SERVER (dogfood breaker): thêm ràng buộc *_format cho events / event_overrides.
-- Hàm idempotent: ràng buộc theo tên, chạy lại chỉ thêm cái còn thiếu. NOT VALID — chỉ dòng mới/sửa.

create or replace function public.ensure_calendar_limits() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n integer := 0;
  spec record;
begin
  for spec in
    select * from (values
      ('app_vn_app_calendar_events', 'app_vn_app_calendar_events_limits',
       'char_length(title) <= 200 and kind in (''event'', ''reminder'') and all_day in (0, 1) and fixed in (0, 1) '
       'and repeat_unit in (''day'', ''week'', ''month'', ''year'') and repeat_every between 1 and 365 '
       'and repeat_cal in (''solar'', ''lunar'') and lunar_month between 1 and 12 and lunar_day between 1 and 30 '
       'and alert_min in (0, 10, 60, 1440) '
       'and char_length(start_local) <= 16 and char_length(end_local) <= 16 and char_length(repeat_until) <= 16 '
       'and char_length(tz) <= 64 and char_length(src_app) <= 64 and char_length(src_id) <= 64'),
      -- Dogfood vòng 5 (breaker): định dạng thật của ngày/giờ — "rac", "9999-99-99", số âm không được vào DB.
      ('app_vn_app_calendar_events', 'app_vn_app_calendar_events_format',
       'start_local ~ ''^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$'' and (end_local is null or end_local ~ ''^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'') '
       'and (repeat_until is null or repeat_until ~ ''^\d{4}-\d{2}-\d{2}$'') and (start_ms is null or start_ms between 0 and 4102444800000) '
       'and (end_ms is null or end_ms between 0 and 4102444800000) and (done_at_ms is null or done_at_ms >= 0)'),
      ('app_vn_app_calendar_event_overrides', 'app_vn_app_calendar_event_overrides_limits',
       'action in (''skip'', ''edit'', ''done'', ''snooze'') and char_length(patch) <= 4000 '
       'and char_length(occ_date) <= 10 and char_length(event_id) <= 64'),
      ('app_vn_app_calendar_event_overrides', 'app_vn_app_calendar_event_overrides_format',
       'occ_date ~ ''^\d{4}-\d{2}-\d{2}$'' and left(patch, 1) = ''{''')
    ) as t(tbl, con, cond)
  loop
    if to_regclass('public.' || spec.tbl) is not null
       and not exists (select 1 from pg_constraint where conname = spec.con and conrelid = to_regclass('public.' || spec.tbl)) then
      execute format('alter table public.%I add constraint %I check (%s) not valid', spec.tbl, spec.con, spec.cond);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

select public.ensure_calendar_limits();
