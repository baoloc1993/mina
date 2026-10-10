-- Vòng 7 (W7) AC-1/AC-3: rate_limits + hit_rate_limit(), purge_rate_limits(), app_opens_daily + record_app_open()
-- (migration 20261010000007). Chạy: `make test` (supabase test db).
begin;
select no_plan();

select has_table('public', 'rate_limits', 'có bảng rate_limits');
select has_table('public', 'app_opens_daily', 'có bảng app_opens_daily');
select has_function('public', 'hit_rate_limit', array['text', 'integer', 'integer'], 'có hit_rate_limit()');
select has_function('public', 'record_app_open', array['uuid', 'text'], 'có record_app_open()');

-- Quyền: chỉ service_role chạm được.
select is(has_function_privilege('authenticated', 'public.hit_rate_limit(text,integer,integer)', 'execute'), false, 'authenticated KHÔNG gọi hit_rate_limit');
select is(has_function_privilege('anon', 'public.hit_rate_limit(text,integer,integer)', 'execute'), false, 'anon KHÔNG gọi hit_rate_limit');
select is(has_function_privilege('service_role', 'public.hit_rate_limit(text,integer,integer)', 'execute'), true, 'service_role gọi được hit_rate_limit');
select is(has_function_privilege('authenticated', 'public.record_app_open(uuid,text)', 'execute'), false, 'authenticated KHÔNG gọi record_app_open');
select is(has_function_privilege('authenticated', 'public.purge_rate_limits()', 'execute'), false, 'authenticated KHÔNG gọi purge_rate_limits');
select is(has_table_privilege('authenticated', 'public.rate_limits', 'select'), false, 'authenticated KHÔNG đọc rate_limits');
select is(has_table_privilege('authenticated', 'public.rate_limits', 'insert'), false, 'authenticated KHÔNG ghi rate_limits');
select is(has_table_privilege('authenticated', 'public.app_opens_daily', 'insert'), false, 'authenticated KHÔNG ghi app_opens_daily');
select is(has_table_privilege('authenticated', 'public.app_opens_daily', 'select'), true, 'authenticated đọc app_opens_daily (qua RLS)');

-- Đếm: 3 lần tối đa → lần 4 bị chặn, retry_after trong (0, window].
select is((select allowed from public.hit_rate_limit('t:u1', 60, 3)), true, 'lần 1 qua');
select is((select allowed from public.hit_rate_limit('t:u1', 60, 3)), true, 'lần 2 qua');
select is((select allowed from public.hit_rate_limit('t:u1', 60, 3)), true, 'lần 3 qua (đúng trần)');
select is((select allowed from public.hit_rate_limit('t:u1', 60, 3)), false, 'lần 4 bị chặn');
select is((select hits from public.hit_rate_limit('t:u1', 60, 3)), 5, 'bị chặn vẫn tăng đếm (spam không xả được trần)');
select ok((select retry_after_s between 1 and 60 from public.hit_rate_limit('t:u1', 60, 3)), 'retry_after_s trong 1..60');
-- Khoá khác không ảnh hưởng nhau.
select is((select allowed from public.hit_rate_limit('t:u2', 60, 3)), true, 'user khác có trần riêng');
select is((select allowed from public.hit_rate_limit('other:u1', 60, 3)), true, 'chức năng khác có trần riêng');
-- Tham số sai.
select throws_ok($$select * from public.hit_rate_limit('', 60, 3)$$, 'BAD_RATE_LIMIT_ARGS', 'khoá rỗng bị từ chối');
select throws_ok($$select * from public.hit_rate_limit('x', 0, 3)$$, 'BAD_RATE_LIMIT_ARGS', 'cửa sổ 0 giây bị từ chối');
select throws_ok($$select * from public.hit_rate_limit('x', 60, 0)$$, 'BAD_RATE_LIMIT_ARGS', 'trần 0 bị từ chối');

-- Dọn: dòng cũ hơn 1 giờ bị xoá, dòng mới giữ.
insert into public.rate_limits (key, window_start, count) values ('old:u', now() - interval '2 hours', 9), ('new:u', now(), 1);
select is(public.purge_rate_limits() >= 1, true, 'purge_rate_limits xoá dòng quá 1 giờ');
select is((select count(*)::int from public.rate_limits where key = 'old:u'), 0, 'dòng 2 giờ trước đã mất');
select is((select count(*)::int from public.rate_limits where key = 'new:u'), 1, 'dòng mới còn');

-- app_opens_daily: hai lần mở cùng ngày = một dòng opens 2; RLS theo tenant.
insert into auth.users (id, email, instance_id, aud, role) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'a@ops.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-0000-0000-0000000000d1', 'b@ops.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
create temp table ids as
  select (select id from public.tenants where owner_user_id = 'aaaaaaaa-0000-0000-0000-0000000000c1') as ta,
         (select id from public.tenants where owner_user_id = 'bbbbbbbb-0000-0000-0000-0000000000d1') as tb;
grant select on ids to authenticated;

select public.record_app_open((select ta from ids), 'vn.app.note');
select public.record_app_open((select ta from ids), 'vn.app.note');
select public.record_app_open((select ta from ids), 'vn.app.news');
select public.record_app_open((select tb from ids), 'vn.app.note');
select is((select opens from public.app_opens_daily where tenant_id = (select ta from ids) and app_id = 'vn.app.note'), 2, 'mở hai lần cùng ngày → opens = 2');
select is((select count(*)::int from public.app_opens_daily where tenant_id = (select ta from ids)), 2, 'tenant A có 2 dòng (hai app)');
select is((select day from public.app_opens_daily where tenant_id = (select ta from ids) and app_id = 'vn.app.news'),
          (now() at time zone 'Asia/Ho_Chi_Minh')::date, 'ngày tính theo giờ Việt Nam');

-- RLS: A chỉ thấy dòng của A, B chỉ thấy của B; không ghi trực tiếp.
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'role', 'authenticated', 'tenant_id', (select ta from ids))::text, true);
set local role authenticated;
select is((select count(*)::int from public.app_opens_daily), 2, 'A thấy đúng 2 dòng của mình');
select is((select count(*)::int from public.app_opens_daily where tenant_id = (select tb from ids)), 0, 'A thấy 0 dòng của B');
select throws_ok($$insert into public.app_opens_daily (tenant_id, app_id, day) values ((select ta from ids), 'x.y.z', current_date)$$, '42501', null, 'A KHÔNG ghi thẳng app_opens_daily');
reset role;
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-0000000000d1', 'role', 'authenticated', 'tenant_id', (select tb from ids))::text, true);
set local role authenticated;
select is((select count(*)::int from public.app_opens_daily), 1, 'B thấy đúng 1 dòng của mình');
select throws_ok($$select * from public.rate_limits$$, '42501', null, 'B KHÔNG đọc rate_limits');
reset role;

-- Ranh giới cửa sổ: dòng đếm của cửa sổ TRƯỚC (đã đầy 99) không được dồn sang cửa sổ hiện tại; sang cửa sổ mới đếm lại từ 1.
insert into public.rate_limits (key, window_start, count)
  values ('win:u', to_timestamp(floor(extract(epoch from now()) / 60) * 60) - interval '60 seconds', 99);
select is((select hits from public.hit_rate_limit('win:u', 60, 3)), 1, 'cửa sổ mới đếm lại từ 1, không thừa hưởng 99 của cửa sổ trước');
select is((select count(*)::int from public.rate_limits where key = 'win:u'), 2, 'cửa sổ cũ và mới là hai dòng riêng');
-- Cửa sổ khác độ dài ⇒ ranh giới khác nhưng vẫn đếm đúng một dòng/khoá/cửa sổ.
select is((select allowed from public.hit_rate_limit('win:v', 3600, 1)), true, 'cửa sổ 1 giờ: lần 1 qua');
select is((select allowed from public.hit_rate_limit('win:v', 3600, 1)), false, 'cửa sổ 1 giờ: lần 2 bị chặn (trần 1)');

-- purge: ranh giới 1 giờ — dòng 59 phút trước còn, 61 phút trước mất; dòng bị xoá không kéo theo dòng khác của cùng khoá.
insert into public.rate_limits (key, window_start, count) values
  ('edge:u', now() - interval '59 minutes', 5), ('edge:u', now() - interval '61 minutes', 5);
select public.purge_rate_limits();
select is((select count(*)::int from public.rate_limits where key = 'edge:u'), 1, 'purge giữ dòng 59 phút, xoá dòng 61 phút');
select is((select count(*)::int from public.rate_limits where key = 'win:u'), 2, 'purge không đụng dòng cửa sổ hiện tại / vừa qua');

select * from finish();
rollback;
