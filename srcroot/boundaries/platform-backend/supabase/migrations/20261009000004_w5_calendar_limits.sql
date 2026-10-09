-- Vòng 5 (W5) — trần độ dài / giá trị hợp lệ ở SERVER cho bảng Lịch (`events`, `event_overrides`) và bảng `note_reminders` của Ghi chú 0.2.0.
-- Cùng lý do với W4 (20261009000003): bảng `app_vn_app_*` do `registry publish` dựng, lint của CLI không cho `ADD CONSTRAINT` trong migration
-- của app, nên ràng buộc đặt ở ĐÂY dưới dạng hàm idempotent. Chạy ngay khi có bảng và PHẢI chạy lại sau mỗi lần `registry publish` dựng bảng
-- (seed gọi sau publish; deploy vòng 7 gọi sau `registry publish`). NOT VALID: chỉ kiểm dòng mới/sửa. Bảng chưa tồn tại → bỏ qua, không lỗi.
-- Vi phạm → `upload` trả REJECTED/SCHEMA (ARCHITECTURE.md §5 `api-upload`). Giá trị NULL luôn qua CHECK (cột tuỳ chọn).

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
      ('app_vn_app_calendar_event_overrides', 'app_vn_app_calendar_event_overrides_limits',
       'action in (''skip'', ''edit'', ''done'', ''snooze'') and char_length(patch) <= 4000 '
       'and char_length(occ_date) <= 10 and char_length(event_id) <= 64')
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

revoke all on function public.ensure_calendar_limits() from public, anon, authenticated;
grant execute on function public.ensure_calendar_limits() to service_role;

-- Mở rộng ensure_note_limits(): giữ nguyên 4 ràng buộc W4, thêm `note_reminders` (Ghi chú 0.2.0).
create or replace function public.ensure_note_limits() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n integer := 0;
  spec record;
begin
  for spec in
    select * from (values
      ('app_vn_app_note_notes', 'app_vn_app_note_notes_limits',
       'char_length(title) <= 200 and char_length(snippet) <= 400 and char_length(search_text) <= 200000 and pinned in (0, 1)'),
      ('app_vn_app_note_note_blocks', 'app_vn_app_note_note_blocks_limits',
       'kind in (''update'', ''snapshot'') and size >= 0 and char_length(data) <= 3000000'),
      ('app_vn_app_note_note_tags', 'app_vn_app_note_note_tags_limits',
       'char_length(note_id) <= 64 and char_length(tag_id) <= 64'),
      ('app_vn_app_note_note_files', 'app_vn_app_note_note_files_limits',
       'kind in (''image'', ''pdf'') and char_length(coalesce(name, '''')) <= 255 and char_length(coalesce(mime, '''')) <= 100 and coalesce(size, 0) >= 0'),
      ('app_vn_app_note_note_reminders', 'app_vn_app_note_note_reminders_limits',
       'char_length(title) <= 200 and char_length(at_local) <= 16 and char_length(note_id) <= 64')
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
select public.ensure_note_limits();
