-- Vòng 5 (W5): ensure_calendar_limits() + ensure_note_limits() mở rộng (migration 20261009000004) và RLS bảng Lịch.
-- Chạy: `make test` (supabase test db). Bảng `app_vn_app_calendar_*` / `note_reminders` được dựng tạm trong giao dịch nếu `registry publish` chưa tạo.
begin;
select no_plan();

select has_function('public', 'ensure_calendar_limits', array[]::text[], 'có hàm ensure_calendar_limits()');
select is(has_function_privilege('authenticated', 'public.ensure_calendar_limits()', 'execute'), false, 'authenticated KHÔNG chạy được ensure_calendar_limits');
select is(has_function_privilege('anon', 'public.ensure_calendar_limits()', 'execute'), false, 'anon KHÔNG chạy được ensure_calendar_limits');
select is(has_function_privilege('service_role', 'public.ensure_calendar_limits()', 'execute'), true, 'service_role chạy được ensure_calendar_limits');

-- Bảng chưa tồn tại (chưa publish Lịch / Ghi chú 0.2.0) → không lỗi, trả 0.
select is(case when to_regclass('public.app_vn_app_calendar_events') is null and to_regclass('public.app_vn_app_calendar_event_overrides') is null
               then public.ensure_calendar_limits() else 0 end, 0, 'chưa publish Lịch → ensure_calendar_limits trả 0 không lỗi');
select lives_ok($$select public.ensure_note_limits()$$, 'ensure_note_limits chạy được khi note_reminders chưa có (bỏ qua không lỗi)');

insert into auth.users (id, email, instance_id, aud, role) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'a@cal.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'b@cal.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
create temp table ids as
  select (select id from public.tenants where owner_user_id = 'aaaaaaaa-0000-0000-0000-0000000000c1') as ta,
         (select id from public.tenants where owner_user_id = 'bbbbbbbb-0000-0000-0000-0000000000c1') as tb;
grant select on ids to authenticated;

-- Dựng bảng như registry publish sẽ dựng (bỏ qua nếu đã có) — cột theo ARCHITECTURE §6.
create table if not exists public.app_vn_app_calendar_events (
  id text primary key, kind text, title text, all_day integer, start_local text, end_local text, fixed integer,
  start_ms bigint, end_ms bigint, tz text, repeat_unit text, repeat_every integer, repeat_cal text, repeat_until text,
  lunar_month integer, lunar_day integer, alert_min integer, done_at_ms bigint, src_app text, src_id text,
  tenant_id uuid not null references public.tenants (id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz);
create table if not exists public.app_vn_app_calendar_event_overrides (
  id text primary key, event_id text, occ_date text, action text, patch text,
  tenant_id uuid not null references public.tenants (id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz);
create table if not exists public.app_vn_app_note_note_reminders (
  id text primary key, note_id text, at_local text, title text,
  tenant_id uuid not null references public.tenants (id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz);

-- RLS + grant như hardenSyncTable (idempotent với bảng thật).
do $$ declare t text; begin
  foreach t in array array['app_vn_app_calendar_events', 'app_vn_app_calendar_event_overrides', 'app_vn_app_note_note_reminders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I using (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid) with check (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid)', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;

select cmp_ok(public.ensure_calendar_limits(), '>=', 0, 'ensure_calendar_limits chạy sau khi có bảng');
select is(public.ensure_calendar_limits(), 0, 'idempotent: gọi lại không thêm ràng buộc');
select cmp_ok(public.ensure_note_limits(), '>=', 0, 'ensure_note_limits chạy sau khi có note_reminders');
select is(public.ensure_note_limits(), 0, 'idempotent: ensure_note_limits gọi lại không thêm');
select is((select count(*)::int from pg_constraint where conname in ('app_vn_app_calendar_events_limits', 'app_vn_app_calendar_event_overrides_limits', 'app_vn_app_note_note_reminders_limits')), 3, 'đủ 3 ràng buộc mới');
select is((select convalidated from pg_constraint where conname = 'app_vn_app_calendar_events_limits'), false, 'ràng buộc NOT VALID (không quét dữ liệu cũ)');

-- Dòng hợp lệ mẫu: mỗi test xấu đổi đúng một giá trị so với dòng này.
create function pg_temp.ev(over jsonb default '{}') returns void language plpgsql as $f$
declare b jsonb := jsonb_build_object(
  'id', gen_random_uuid()::text, 'kind', 'event', 'title', 'Khám răng', 'all_day', 0, 'start_local', '2026-10-14T14:00', 'end_local', '2026-10-14T15:00',
  'fixed', 0, 'repeat_every', 1, 'repeat_cal', 'solar', 'alert_min', 60) || over;
begin
  insert into public.app_vn_app_calendar_events (id, tenant_id, kind, title, all_day, start_local, end_local, fixed, start_ms, end_ms, tz, repeat_unit,
      repeat_every, repeat_cal, repeat_until, lunar_month, lunar_day, alert_min, src_app, src_id)
  values (b->>'id', (select ta from ids), b->>'kind', b->>'title', (b->>'all_day')::int, b->>'start_local', b->>'end_local', (b->>'fixed')::int,
      (b->>'start_ms')::bigint, (b->>'end_ms')::bigint, b->>'tz', b->>'repeat_unit', (b->>'repeat_every')::int, b->>'repeat_cal', b->>'repeat_until',
      (b->>'lunar_month')::int, (b->>'lunar_day')::int, (b->>'alert_min')::int, b->>'src_app', b->>'src_id');
end $f$;

select lives_ok($$select pg_temp.ev()$$, 'events: dòng hợp lệ được nhận');
select lives_ok($$select pg_temp.ev('{"kind":"reminder","title":"Uống thuốc","repeat_unit":"day","alert_min":0}')$$, 'events: lời nhắc lặp ngày hợp lệ');
select lives_ok($$select pg_temp.ev('{"title":"Giỗ ông nội","all_day":1,"start_local":"2026-10-14","end_local":null,"repeat_unit":"year","repeat_cal":"lunar","lunar_month":3,"lunar_day":12}')$$, 'events: lặp năm âm lịch hợp lệ');
select lives_ok($$select pg_temp.ev('{"fixed":1,"start_ms":1790000000000,"end_ms":1790003600000,"tz":"Asia/Ho_Chi_Minh","repeat_unit":"week","repeat_every":365,"alert_min":1440,"src_app":"vn.app.note","src_id":"x"}')$$, 'events: giờ cố định + biên repeat_every 365 hợp lệ');
select lives_ok($$select pg_temp.ev(jsonb_build_object('title', repeat('x', 200)))$$, 'events: title đúng 200 ký tự được nhận');
select throws_ok($$select pg_temp.ev(jsonb_build_object('title', repeat('x', 201)))$$, '23514', null, 'events: title 201 ký tự bị từ chối');
select throws_ok($$select pg_temp.ev('{"kind":"task"}')$$, '23514', null, 'events: kind lạ bị từ chối');
select throws_ok($$select pg_temp.ev('{"all_day":2}')$$, '23514', null, 'events: all_day = 2 bị từ chối');
select throws_ok($$select pg_temp.ev('{"fixed":-1}')$$, '23514', null, 'events: fixed = -1 bị từ chối');
select throws_ok($$select pg_temp.ev('{"repeat_unit":"hourly"}')$$, '23514', null, 'events: repeat_unit = hourly bị từ chối');
select throws_ok($$select pg_temp.ev('{"repeat_every":0}')$$, '23514', null, 'events: repeat_every = 0 bị từ chối');
select throws_ok($$select pg_temp.ev('{"repeat_every":366}')$$, '23514', null, 'events: repeat_every = 366 bị từ chối');
select throws_ok($$select pg_temp.ev('{"repeat_cal":"julian"}')$$, '23514', null, 'events: repeat_cal lạ bị từ chối');
select throws_ok($$select pg_temp.ev('{"lunar_month":13}')$$, '23514', null, 'events: lunar_month = 13 bị từ chối');
select throws_ok($$select pg_temp.ev('{"lunar_month":0}')$$, '23514', null, 'events: lunar_month = 0 bị từ chối');
select throws_ok($$select pg_temp.ev('{"lunar_day":31}')$$, '23514', null, 'events: lunar_day = 31 bị từ chối');
select throws_ok($$select pg_temp.ev('{"alert_min":7}')$$, '23514', null, 'events: alert_min = 7 bị từ chối');
select throws_ok($$select pg_temp.ev('{"start_local":"2026-10-14T14:00:00.000Z"}')$$, '23514', null, 'events: start_local > 16 ký tự bị từ chối');
select throws_ok($$select pg_temp.ev(jsonb_build_object('tz', repeat('z', 65)))$$, '23514', null, 'events: tz > 64 ký tự bị từ chối');
select throws_ok($$select pg_temp.ev(jsonb_build_object('src_app', repeat('a', 65)))$$, '23514', null, 'events: src_app > 64 ký tự bị từ chối');
select throws_ok($$select pg_temp.ev(jsonb_build_object('src_id', repeat('a', 65)))$$, '23514', null, 'events: src_id > 64 ký tự bị từ chối');

-- event_overrides
create function pg_temp.ov(act text, patch text default '{}', occ text default '2026-10-20', eid text default 'e1') returns void language sql as $f$
  insert into public.app_vn_app_calendar_event_overrides (id, tenant_id, event_id, occ_date, action, patch)
  values (gen_random_uuid()::text, (select ta from ids), eid, occ, act, patch);
$f$;
select lives_ok($$select pg_temp.ov('skip')$$, 'overrides: skip hợp lệ');
select lives_ok($$select pg_temp.ov('edit', '{"start_local":"2026-10-20T10:00"}')$$, 'overrides: edit hợp lệ');
select lives_ok($$select pg_temp.ov('done', '{"at_ms":1}')$$, 'overrides: done hợp lệ');
select lives_ok($$select pg_temp.ov('snooze', '{"until_local":"2026-10-20T11:00"}')$$, 'overrides: snooze hợp lệ');
select lives_ok($$select pg_temp.ov('skip', '{' || repeat('p', 3999))$$, 'overrides: patch đúng 4000 ký tự được nhận');
select throws_ok($$select pg_temp.ov('delete')$$, '23514', null, 'overrides: action lạ bị từ chối');
select throws_ok($$select pg_temp.ov('edit', repeat('p', 4001))$$, '23514', null, 'overrides: patch 4001 ký tự bị từ chối');
select throws_ok($$select pg_temp.ov('skip', '{}', '2026-10-20T00:00')$$, '23514', null, 'overrides: occ_date > 10 ký tự bị từ chối');
select throws_ok($$select pg_temp.ov('skip', '{}', '2026-10-20', repeat('e', 65))$$, '23514', null, 'overrides: event_id > 64 ký tự bị từ chối');

-- note_reminders (Ghi chú 0.2.0)
create function pg_temp.nr(ttl text, at text default '2026-10-20T09:00', nid text default 'n1') returns void language sql as $f$
  insert into public.app_vn_app_note_note_reminders (id, tenant_id, note_id, at_local, title)
  values (gen_random_uuid()::text, (select ta from ids), nid, at, ttl);
$f$;
select lives_ok($$select pg_temp.nr('Mua rau')$$, 'note_reminders: dòng hợp lệ được nhận');
select lives_ok($$select pg_temp.nr(repeat('x', 200))$$, 'note_reminders: title 200 ký tự được nhận');
select throws_ok($$select pg_temp.nr(repeat('x', 201))$$, '23514', null, 'note_reminders: title 201 ký tự bị từ chối');
select throws_ok($$select pg_temp.nr('ok', '2026-10-20T09:00:00.000Z')$$, '23514', null, 'note_reminders: at_local > 16 ký tự bị từ chối');
select throws_ok($$select pg_temp.nr('ok', '2026-10-20T09:00', repeat('n', 65))$$, '23514', null, 'note_reminders: note_id > 64 ký tự bị từ chối');

-- Ràng buộc W4 còn nguyên khi bảng notes đã được publish.
select is(case when to_regclass('public.app_vn_app_note_notes') is null then true
           else exists (select 1 from pg_constraint where conname = 'app_vn_app_note_notes_limits') end, true, 'ràng buộc W4 của notes còn nguyên (hoặc bảng chưa có)');

-- RLS: tenant B không đọc/ghi được events của A
insert into public.app_vn_app_calendar_events (id, tenant_id, kind, title, all_day, start_local, fixed, repeat_every, repeat_cal, alert_min)
  values ('cccccccc-0000-0000-0000-0000000000c1', (select ta from ids), 'event', 'của A', 0, '2026-10-14T14:00', 0, 1, 'solar', 0);
insert into public.app_vn_app_calendar_event_overrides (id, tenant_id, event_id, occ_date, action, patch)
  values ('cccccccc-0000-0000-0000-0000000000c2', (select ta from ids), 'cccccccc-0000-0000-0000-0000000000c1', '2026-10-14', 'skip', '{}');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'bbbbbbbb-0000-0000-0000-0000000000c1', 'tenant_id', (select tb from ids))::text, true);

select is((select count(*)::int from public.app_vn_app_calendar_events), 0, 'RLS: tenant B đọc 0 dòng events của A');
select is((select count(*)::int from public.app_vn_app_calendar_event_overrides), 0, 'RLS: tenant B đọc 0 dòng event_overrides của A');
select throws_ok($$insert into public.app_vn_app_calendar_events (id, tenant_id, kind, title, all_day, start_local, fixed, repeat_every, repeat_cal, alert_min)
  values ('dddddddd-0000-0000-0000-0000000000c1', (select ta from ids), 'event', 'bơm vào A', 0, '2026-10-14T14:00', 0, 1, 'solar', 0)$$,
  '42501', null, 'RLS: tenant B không ghi được events vào tenant A (WITH CHECK)');
create temp table upd_count (n int);
grant all on upd_count to authenticated;
do $$ declare c int; begin
  update public.app_vn_app_calendar_events set title = 'bị sửa';
  get diagnostics c = row_count;
  insert into upd_count values (c);
end $$;
select is((select n from upd_count), 0, 'RLS: tenant B không sửa được events của A');
select throws_ok($$delete from public.app_vn_app_calendar_events$$, '42501', null, 'client không có quyền DELETE cứng trên events');

select * from finish();
rollback;
