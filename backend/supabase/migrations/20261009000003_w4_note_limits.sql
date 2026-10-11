-- Vòng 4 (W4) — trần độ dài / giá trị hợp lệ cho bảng Ghi chú ở SERVER (dogfood vòng 4, vai breaker #1): giới hạn 200 ký tự của tiêu đề
-- chỉ có ở giao diện + intent nên một `upload` trực tiếp nhét được 300 000 ký tự, `kind = 'zzz'`, `size = -5`.
--
-- Bảng `app_vn_app_note_*` do `registry publish` dựng và lint của CLI không cho `ADD CONSTRAINT` trong migration của app, nên ràng buộc đặt ở
-- ĐÂY dưới dạng hàm idempotent `ensure_note_limits()`: chạy ngay khi có bảng, và PHẢI chạy lại sau mỗi lần publish dựng bảng mới
-- (seed gọi sau publish; deploy vòng 7 gọi sau `registry publish`). NOT VALID: chỉ kiểm dòng mới/sửa, không quét dữ liệu cũ.
-- Vi phạm → `upload` trả REJECTED/SCHEMA (ARCHITECTURE.md §5 `api-upload`).

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
       'kind in (''image'', ''pdf'') and char_length(coalesce(name, '''')) <= 255 and char_length(coalesce(mime, '''')) <= 100 and coalesce(size, 0) >= 0')
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

revoke all on function public.ensure_note_limits() from public, anon, authenticated;
grant execute on function public.ensure_note_limits() to service_role;

select public.ensure_note_limits();
