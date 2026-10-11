-- Vòng 4 (W4) AC-1 / AC-7: hàm dọn thùng rác Ghi chú `purge_trashed_notes()` (migration 20261009000002).
-- Chạy: `make test` (supabase test db). Bảng `app_vn_app_note_*` được dựng tạm trong giao dịch nếu `registry publish` chưa tạo.
begin;
select no_plan();

select has_function('public', 'purge_trashed_notes', array[]::text[], 'có hàm purge_trashed_notes()');
select is(has_function_privilege('authenticated', 'public.purge_trashed_notes()', 'execute'), false, 'authenticated KHÔNG chạy được hàm dọn');
select is(has_function_privilege('anon', 'public.purge_trashed_notes()', 'execute'), false, 'anon KHÔNG chạy được hàm dọn');
select is(has_function_privilege('service_role', 'public.purge_trashed_notes()', 'execute'), true, 'service_role chạy được hàm dọn');

-- Chưa có bảng của app → trả 0, không lỗi (chỉ kiểm khi bảng thật chưa tồn tại).
select is(case when to_regclass('public.app_vn_app_note_notes') is null then public.purge_trashed_notes() else 0 end, 0, 'chưa publish Ghi chú → trả 0 không lỗi');

-- Dựng bảng như registry publish sẽ dựng (bỏ qua nếu đã có).
insert into auth.users (id, email, instance_id, aud, role) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'a@note.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'b@note.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
create temp table ids as
  select (select id from public.tenants where owner_user_id = 'aaaaaaaa-0000-0000-0000-0000000000a1') as ta,
         (select id from public.tenants where owner_user_id = 'bbbbbbbb-0000-0000-0000-0000000000b1') as tb;

create table if not exists public.app_vn_app_note_notes (
  id text primary key, title text, pinned integer default 0, trashed_at_ms bigint, search_text text, snippet text,
  tenant_id uuid not null references public.tenants (id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz);
create table if not exists public.app_vn_app_note_note_blocks (
  id text primary key, note_id text, kind text, data text, size integer,
  tenant_id uuid not null references public.tenants (id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz);
create table if not exists public.app_vn_app_note_note_tags (
  id text primary key, note_id text, tag_id text,
  tenant_id uuid not null references public.tenants (id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz);
create table if not exists public.app_vn_app_note_note_files (
  id text primary key, note_id text, file_id text, kind text, name text, mime text, size integer,
  tenant_id uuid not null references public.tenants (id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz);

-- Bảng thật (nếu có) có trigger set_updated_at ghi đè updated_at → tắt trong giao dịch này để dựng dữ liệu "quá khứ".
do $$ declare t text; begin
  foreach t in array array['notes', 'note_blocks', 'note_tags', 'note_files'] loop
    execute format('alter table public.app_vn_app_note_%s disable trigger user', t);
  end loop;
end $$;

-- n-old: thùng rác 31 ngày, server cũng 31 ngày → bị dọn · n-new: thùng rác 3 ngày · n-skew: đồng hồ máy lùi về 1970 nhưng server mới sửa
-- · n-live: không ở thùng rác · n-b: của tenant B, quá hạn (hàm chạy toàn cục → cũng bị dọn, tenant nào cũng vậy)
insert into public.app_vn_app_note_notes (id, title, trashed_at_ms, tenant_id, updated_at) values
  ('n-old', 'cũ', (extract(epoch from now() - interval '31 days') * 1000)::bigint, (select ta from ids), now() - interval '31 days'),
  ('n-new', 'mới', (extract(epoch from now() - interval '3 days') * 1000)::bigint, (select ta from ids), now() - interval '3 days'),
  ('n-skew', 'lệch giờ', 1, (select ta from ids), now()),
  ('n-live', 'sống', null, (select ta from ids), now() - interval '90 days'),
  ('n-b', 'của B', (extract(epoch from now() - interval '40 days') * 1000)::bigint, (select tb from ids), now() - interval '40 days');
insert into public.app_vn_app_note_note_blocks (id, note_id, kind, data, tenant_id) values
  ('b-old-1', 'n-old', 'update', 'AA==', (select ta from ids)), ('b-old-2', 'n-old', 'update', 'AA==', (select ta from ids)),
  ('b-new-1', 'n-new', 'update', 'AA==', (select ta from ids)), ('b-live-1', 'n-live', 'snapshot', 'AA==', (select ta from ids));
insert into public.app_vn_app_note_note_tags (id, note_id, tag_id, tenant_id) values ('t-old', 'n-old', 'tag-1', (select ta from ids)), ('t-new', 'n-new', 'tag-1', (select ta from ids));
insert into public.app_vn_app_note_note_files (id, note_id, file_id, kind, name, tenant_id) values ('f-old', 'n-old', 'file-1', 'pdf', 'a.pdf', (select ta from ids));

select cmp_ok(public.purge_trashed_notes(), '>=', 2, 'dọn ít nhất 2 note quá hạn (n-old, n-b; dữ liệu seed quá hạn nếu có cũng bị dọn)');
select is((select string_agg(id, ',' order by id) from public.app_vn_app_note_notes where deleted_at is not null and id in ('n-old', 'n-new', 'n-skew', 'n-live', 'n-b')), 'n-b,n-old', 'chỉ n-old và n-b bị đặt deleted_at');
select is((select deleted_at is null from public.app_vn_app_note_notes where id = 'n-skew'), true, 'đồng hồ máy lùi về 1970 KHÔNG làm note bị xoá sớm (server updated_at còn mới)');
select is((select deleted_at is null from public.app_vn_app_note_notes where id = 'n-new'), true, 'thùng rác 3 ngày còn nguyên');
select is((select deleted_at is null from public.app_vn_app_note_notes where id = 'n-live'), true, 'note không ở thùng rác không bị đụng dù lâu không sửa');
select is((select string_agg(id, ',' order by id) from public.app_vn_app_note_note_blocks where deleted_at is not null and id like 'b-%'), 'b-old-1,b-old-2', 'note_blocks của note bị dọn cũng bị xoá mềm; của note khác giữ nguyên');
select is((select string_agg(id, ',' order by id) from public.app_vn_app_note_note_tags where deleted_at is not null and id like 't-%'), 't-old', 'note_tags của note bị dọn bị xoá mềm');
select is((select string_agg(id, ',' order by id) from public.app_vn_app_note_note_files where deleted_at is not null and id like 'f-%'), 'f-old', 'note_files của note bị dọn bị xoá mềm');
select is(public.purge_trashed_notes(), 0, 'idempotent: chạy lại không dọn thêm');

select * from finish();
rollback;
