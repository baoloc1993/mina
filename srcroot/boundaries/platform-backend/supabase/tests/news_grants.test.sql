-- Vòng 6 (W6): core_net_grants (RLS, sync), app_configs (chỉ service role), ensure_news_limits(), purge_news_items()
-- (migration 20261009000006). Chạy: `make test` (supabase test db). Bảng `app_vn_app_news_*` được dựng tạm trong giao dịch.
begin;
select no_plan();

-- ---------------------------------------------------------------------------------------------
-- core_net_grants: có mặt trong sổ + publication, RLS theo tenant, không DELETE
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'core_net_grants', 'có bảng core_net_grants');
select is((select string_agg(table_name, ',' order by table_name) from public.app_tables where app_id = '_core'), 'core_contacts,core_files,core_net_grants,core_tags', 'app_tables ghi sổ core_net_grants với app_id = _core (upload nhận ghi)');
select is((select count(*)::int from pg_publication_tables where pubname = 'powersync' and tablename = 'core_net_grants'), 1, 'core_net_grants nằm trong publication powersync');
select is((select relrowsecurity from pg_class where oid = 'public.core_net_grants'::regclass), true, 'core_net_grants bật RLS');
select is(has_table_privilege('authenticated', 'public.core_net_grants', 'delete'), false, 'authenticated KHÔNG DELETE core_net_grants (thu hồi = xoá mềm)');
select is(has_table_privilege('anon', 'public.core_net_grants', 'select'), false, 'anon không đọc core_net_grants');

insert into auth.users (id, email, instance_id, aud, role) values
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'a@news.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-0000-0000-0000000000d1', 'b@news.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
create temp table ids as
  select (select id from public.tenants where owner_user_id = 'aaaaaaaa-0000-0000-0000-0000000000d1') as ta,
         (select id from public.tenants where owner_user_id = 'bbbbbbbb-0000-0000-0000-0000000000d1') as tb;
grant select on ids to authenticated;

-- Tenant A ghi grant của mình; đọc lại thấy 1 dòng; tenant B thấy 0; B ghi grant mang tenant_id của A bị WITH CHECK chặn.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'role', 'authenticated', 'tenant_id', (select ta from ids))::text, true);
select lives_ok($$insert into public.core_net_grants (id, tenant_id, app_id, host) values ('11111111-1111-4111-8111-111111111111', (select ta from ids), 'vn.app.news', 'blog.example.dev')$$, 'tenant A ghi grant của mình');
select lives_ok($$insert into public.core_net_grants (id, tenant_id, app_id, host) values ('11111111-1111-4111-8111-111111111112', (select ta from ids), 'vn.app.news', '10.0.2.2:8787')$$, 'host có cổng hợp lệ');
select is((select count(*)::int from public.core_net_grants), 2, 'tenant A thấy 2 dòng của mình');
select lives_ok($$update public.core_net_grants set deleted_at = now() where id = '11111111-1111-4111-8111-111111111112'$$, 'thu hồi = xoá mềm (UPDATE deleted_at)');
select throws_ok($$delete from public.core_net_grants where id = '11111111-1111-4111-8111-111111111111'$$, '42501', null, 'DELETE bị từ chối (không có quyền)');
select throws_ok($$insert into public.core_net_grants (id, tenant_id, app_id, host) values (gen_random_uuid(), (select ta from ids), 'vn.app.news', '*.vn')$$, '23514', null, 'host có wildcard bị CHECK chặn');
select throws_ok($$insert into public.core_net_grants (id, tenant_id, app_id, host) values (gen_random_uuid(), (select ta from ids), 'vn.app.news', 'https://a.vn')$$, '23514', null, 'host có scheme bị CHECK chặn');
select throws_ok($$insert into public.core_net_grants (id, tenant_id, app_id, host) values (gen_random_uuid(), (select ta from ids), 'vn.app.news', 'u:p@a.vn')$$, '23514', null, 'host có user:pass@ bị CHECK chặn');
select throws_ok($$insert into public.core_net_grants (id, tenant_id, app_id, host) values (gen_random_uuid(), (select ta from ids), 'khong hop le', 'a.vn')$$, '23514', null, 'app_id sai khuôn bị CHECK chặn');

select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-0000000000d1', 'role', 'authenticated', 'tenant_id', (select tb from ids))::text, true);
select is((select count(*)::int from public.core_net_grants), 0, 'tenant B thấy 0 dòng grant của A');
select throws_ok($$insert into public.core_net_grants (id, tenant_id, app_id, host) values (gen_random_uuid(), (select ta from ids), 'vn.app.news', 'evil.example')$$, '42501', null, 'B ghi grant mang tenant_id của A bị RLS WITH CHECK chặn');
with u as (update public.core_net_grants set deleted_at = now() where id = '11111111-1111-4111-8111-111111111111' returning 1)
select is((select count(*)::int from u), 0, 'B không thu hồi được grant của A (0 dòng)');
reset role;
select is((select deleted_at is null from public.core_net_grants where id = '11111111-1111-4111-8111-111111111111'), true, 'grant của A còn sống sau nỗ lực của B');

-- ---------------------------------------------------------------------------------------------
-- app_configs: chỉ service role; authenticated/anon không đọc, không ghi
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'app_configs', 'có bảng app_configs');
select is(has_table_privilege('authenticated', 'public.app_configs', 'select'), false, 'authenticated KHÔNG đọc app_configs trực tiếp (đi qua catalog)');
select is(has_table_privilege('authenticated', 'public.app_configs', 'insert'), false, 'authenticated KHÔNG ghi app_configs');
select is(has_table_privilege('anon', 'public.app_configs', 'select'), false, 'anon KHÔNG đọc app_configs');
select is(has_table_privilege('service_role', 'public.app_configs', 'insert'), true, 'service_role ghi được app_configs');
insert into public.apps (id, name, table_prefix) values ('vn.app.cfgtest', 'Cfg test', 'app_vn_app_cfgtest');
select lives_ok($$insert into public.app_configs (app_id, config) values ('vn.app.cfgtest', '{"network":["a.vn"],"sources":[]}')$$, 'ghi cấu hình object');
select throws_ok($$insert into public.app_configs (app_id, config) values ('vn.app.cfgtest', '[1]')$$, '23514', null, 'cấu hình không phải object bị CHECK chặn');

-- ---------------------------------------------------------------------------------------------
-- ensure_news_limits()
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'ensure_news_limits', array[]::text[], 'có hàm ensure_news_limits()');
select is(has_function_privilege('authenticated', 'public.ensure_news_limits()', 'execute'), false, 'authenticated KHÔNG chạy được ensure_news_limits');
select is(has_function_privilege('service_role', 'public.ensure_news_limits()', 'execute'), true, 'service_role chạy được ensure_news_limits');
select is(case when to_regclass('public.app_vn_app_news_items') is null and to_regclass('public.app_vn_app_news_sources') is null
               then public.ensure_news_limits() else 0 end, 0, 'chưa publish Đọc báo → ensure_news_limits trả 0 không lỗi');

create table if not exists public.app_vn_app_news_sources (
  id text primary key, name text, feed_url text, host text, position integer, suggested_key text,
  last_fetched_at_ms bigint, last_error text,
  tenant_id uuid not null references public.tenants (id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz);
create table if not exists public.app_vn_app_news_items (
  id text primary key, source_id text, guid text, title text, summary text, link text, image_url text,
  published_at_ms bigint, fetched_at_ms bigint, read_at_ms bigint, saved_at_ms bigint, note_id text,
  tenant_id uuid not null references public.tenants (id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz);

select cmp_ok(public.ensure_news_limits(), '>=', 0, 'ensure_news_limits chạy sau khi có bảng');
select is(public.ensure_news_limits(), 0, 'idempotent: gọi lại không thêm ràng buộc');
select is((select count(*)::int from pg_constraint where conname in ('app_vn_app_news_sources_limits', 'app_vn_app_news_items_limits')), 2, 'đủ 2 ràng buộc');
select is((select convalidated from pg_constraint where conname = 'app_vn_app_news_items_limits'), false, 'ràng buộc NOT VALID (không quét dữ liệu cũ)');

create function pg_temp.src(over jsonb default '{}') returns void language plpgsql as $f$
declare b jsonb := jsonb_build_object('id', gen_random_uuid()::text, 'name', 'VnExpress', 'feed_url', 'https://vnexpress.net/rss/tin-moi-nhat.rss',
  'host', 'vnexpress.net', 'position', 0, 'last_fetched_at_ms', 1760000000000) || over;
begin
  insert into public.app_vn_app_news_sources (id, name, feed_url, host, position, suggested_key, last_fetched_at_ms, last_error, tenant_id)
  values (b->>'id', b->>'name', b->>'feed_url', b->>'host', (b->>'position')::int, b->>'suggested_key', (b->>'last_fetched_at_ms')::bigint, b->>'last_error', (select ta from ids));
end $f$;
create function pg_temp.itm(over jsonb default '{}') returns void language plpgsql as $f$
declare b jsonb := jsonb_build_object('id', gen_random_uuid()::text, 'source_id', 's1', 'guid', 'g', 'title', 'Tiêu đề', 'summary', 'Tóm tắt',
  'link', 'https://vnexpress.net/a', 'fetched_at_ms', 1760000000000) || over;
begin
  insert into public.app_vn_app_news_items (id, source_id, guid, title, summary, link, image_url, published_at_ms, fetched_at_ms, read_at_ms, saved_at_ms, note_id, tenant_id)
  values (b->>'id', b->>'source_id', b->>'guid', b->>'title', b->>'summary', b->>'link', b->>'image_url', (b->>'published_at_ms')::bigint,
          (b->>'fetched_at_ms')::bigint, (b->>'read_at_ms')::bigint, (b->>'saved_at_ms')::bigint, b->>'note_id', (select ta from ids));
end $f$;

select lives_ok($$select pg_temp.src()$$, 'nguồn hợp lệ qua CHECK');
select lives_ok($$select pg_temp.src('{"host":"10.0.2.2:8787"}')$$, 'host có cổng qua CHECK');
select throws_ok($$select pg_temp.src(jsonb_build_object('name', repeat('x', 101)))$$, '23514', null, 'name > 100 bị chặn');
select throws_ok($$select pg_temp.src('{"host":"*.vn"}')$$, '23514', null, 'host wildcard bị chặn');
select throws_ok($$select pg_temp.src('{"host":"u:p@a.vn"}')$$, '23514', null, 'host user:pass@ bị chặn');
select throws_ok($$select pg_temp.src('{"position":-1}')$$, '23514', null, 'position âm bị chặn');
select throws_ok($$select pg_temp.src(jsonb_build_object('last_error', repeat('x', 301)))$$, '23514', null, 'last_error > 300 bị chặn');
select throws_ok($$select pg_temp.src('{"last_fetched_at_ms":99999999999999}')$$, '23514', null, 'epoch > 2100 bị chặn');
select lives_ok($$select pg_temp.itm()$$, 'bài hợp lệ qua CHECK');
select lives_ok($$select pg_temp.itm('{"note_id":"123e4567-e89b-42d3-a456-426614174000"}')$$, 'note_id UUID qua CHECK');
select throws_ok($$select pg_temp.itm(jsonb_build_object('title', repeat('x', 301)))$$, '23514', null, 'title > 300 bị chặn');
select throws_ok($$select pg_temp.itm(jsonb_build_object('summary', repeat('x', 2001)))$$, '23514', null, 'summary > 2000 bị chặn');
select throws_ok($$select pg_temp.itm(jsonb_build_object('link', repeat('x', 2049)))$$, '23514', null, 'link > 2048 bị chặn');
select throws_ok($$select pg_temp.itm('{"read_at_ms":-1}')$$, '23514', null, 'read_at_ms âm bị chặn');
select throws_ok($$select pg_temp.itm('{"saved_at_ms":99999999999999}')$$, '23514', null, 'saved_at_ms > 2100 bị chặn');
select throws_ok($$select pg_temp.itm('{"note_id":"khong-phai-uuid"}')$$, '23514', null, 'note_id sai khuôn UUID bị chặn');

-- ---------------------------------------------------------------------------------------------
-- purge_news_items()
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'purge_news_items', array[]::text[], 'có hàm purge_news_items()');
select is(has_function_privilege('authenticated', 'public.purge_news_items()', 'execute'), false, 'authenticated KHÔNG chạy được hàm dọn');
select is(has_function_privilege('anon', 'public.purge_news_items()', 'execute'), false, 'anon KHÔNG chạy được hàm dọn');
select is(has_function_privilege('service_role', 'public.purge_news_items()', 'execute'), true, 'service_role chạy được hàm dọn');

-- Trigger set_updated_at (nếu bảng thật có) ghi đè updated_at → tắt trong giao dịch này để dựng dữ liệu "quá khứ".
do $$ begin
  execute 'alter table public.app_vn_app_news_items disable trigger user';
end $$;
delete from public.app_vn_app_news_items;
-- i-old: tải 31 ngày trước, server cũng 31 ngày · i-new: 3 ngày · i-saved: 90 ngày nhưng đã đọc sau · i-skew: đồng hồ máy 1970 nhưng server mới
-- · i-future: fetched_at_ms ở tương lai nhưng server cũ (không bị dọn: mốc máy chưa quá 30 ngày)
insert into public.app_vn_app_news_items (id, source_id, guid, title, summary, link, fetched_at_ms, saved_at_ms, tenant_id, updated_at) values
  ('i-old', 's', 'g1', 't', 's', 'https://a.vn/1', (extract(epoch from now() - interval '31 days') * 1000)::bigint, null, (select ta from ids), now() - interval '31 days'),
  ('i-new', 's', 'g2', 't', 's', 'https://a.vn/2', (extract(epoch from now() - interval '3 days') * 1000)::bigint, null, (select ta from ids), now() - interval '3 days'),
  ('i-saved', 's', 'g3', 't', 's', 'https://a.vn/3', (extract(epoch from now() - interval '90 days') * 1000)::bigint, 1760000000000, (select ta from ids), now() - interval '90 days'),
  ('i-skew', 's', 'g4', 't', 's', 'https://a.vn/4', 1, null, (select ta from ids), now()),
  ('i-future', 's', 'g5', 't', 's', 'https://a.vn/5', (extract(epoch from now() + interval '10 days') * 1000)::bigint, null, (select ta from ids), now() - interval '40 days'),
  ('i-b', 's', 'g6', 't', 's', 'https://a.vn/6', (extract(epoch from now() - interval '40 days') * 1000)::bigint, null, (select tb from ids), now() - interval '40 days');

select is(public.purge_news_items(), 2, 'dọn đúng 2 bài (i-old, i-b: hàm chạy toàn cục)');
select is((select string_agg(id, ',' order by id) from public.app_vn_app_news_items where deleted_at is not null), 'i-b,i-old', 'chỉ i-old và i-b bị đặt deleted_at');
select is((select deleted_at is null from public.app_vn_app_news_items where id = 'i-saved'), true, 'bài đọc sau KHÔNG bao giờ bị dọn dù 90 ngày');
select is((select deleted_at is null from public.app_vn_app_news_items where id = 'i-skew'), true, 'đồng hồ máy lùi về 1970 KHÔNG làm bài bị xoá sớm (server updated_at còn mới)');
select is((select deleted_at is null from public.app_vn_app_news_items where id = 'i-new'), true, 'bài 3 ngày còn nguyên');
select is((select deleted_at is null from public.app_vn_app_news_items where id = 'i-future'), true, 'fetched_at_ms ở tương lai (đồng hồ máy nhanh) không bị dọn');
select is(public.purge_news_items(), 0, 'idempotent: chạy lại không dọn thêm');

select * from finish();
rollback;
