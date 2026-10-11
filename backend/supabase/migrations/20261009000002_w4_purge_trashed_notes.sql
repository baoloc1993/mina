-- Vòng 4 (W4) — dọn thùng rác Ghi chú phía server (AC-1, DECISIONS 2026-10-09 "Thùng rác").
-- Cộng thêm duy nhất: hàm `purge_trashed_notes()` + job pg_cron hằng ngày. Không đụng bảng/API đã giao ở vòng 1–3.
--
-- Bảng của app Ghi chú (`app_vn_app_note_*`) chỉ tồn tại sau khi `registry publish` gói `vn.app.note` chạy migration của gói,
-- nên hàm tra `to_regclass` và trả 0 khi chưa có — không lỗi.
--
-- Điều kiện xoá hẳn (đặt `deleted_at`, tức xoá mềm — "xoá thắng sửa" nên máy offline tới sau không hồi sinh được):
--   (1) `trashed_at_ms` (đồng hồ MÁY khách, epoch ms) quá 30 ngày, VÀ
--   (2) `updated_at` (giờ SERVER, do trigger đặt; note thùng rác không bị sửa nên đứng yên) cũng quá 30 ngày.
-- Cần cả hai để đồng hồ máy khách lệch (lùi về 1970) không làm note bị xoá sớm.

create or replace function public.purge_trashed_notes() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ids text[];
  n integer := 0;
begin
  if to_regclass('public.app_vn_app_note_notes') is null then
    return 0;
  end if;

  execute $q$
    with doomed as (
      update public.app_vn_app_note_notes
         set deleted_at = now()
       where deleted_at is null
         and trashed_at_ms is not null
         and trashed_at_ms < (extract(epoch from now() - interval '30 days') * 1000)::bigint
         and updated_at < now() - interval '30 days'
      returning id)
    select coalesce(array_agg(id), '{}'::text[]) from doomed
  $q$ into ids;

  n := coalesce(cardinality(ids), 0);
  if n = 0 then
    return 0;
  end if;

  if to_regclass('public.app_vn_app_note_note_blocks') is not null then
    execute 'update public.app_vn_app_note_note_blocks set deleted_at = now() where deleted_at is null and note_id = any($1)' using ids;
  end if;
  if to_regclass('public.app_vn_app_note_note_tags') is not null then
    execute 'update public.app_vn_app_note_note_tags set deleted_at = now() where deleted_at is null and note_id = any($1)' using ids;
  end if;
  if to_regclass('public.app_vn_app_note_note_files') is not null then
    execute 'update public.app_vn_app_note_note_files set deleted_at = now() where deleted_at is null and note_id = any($1)' using ids;
  end if;
  return n;
end $$;

revoke all on function public.purge_trashed_notes() from public, anon, authenticated;
grant execute on function public.purge_trashed_notes() to service_role;

-- Lịch: 03:00 UTC mỗi ngày. pg_cron có sẵn trong image Postgres của Supabase; môi trường nào không có thì bỏ qua lịch
-- (hàm vẫn dùng được bằng tay) — bật lại ở Supabase Cloud (vòng 7).
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('purge-trashed-notes', '0 3 * * *', 'select public.purge_trashed_notes()');
exception when others then
  raise notice 'pg_cron không khả dụng, bỏ qua lịch dọn thùng rác: %', sqlerrm;
end $$;
