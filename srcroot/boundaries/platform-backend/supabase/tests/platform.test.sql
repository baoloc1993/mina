-- Vòng 2 (W2): AC-1 (gộp identity), AC-2 (thiết bị), AC-4/6 (ràng buộc version, thu hồi), AC-5 (catalog theo tenant),
-- AC-7 (quota), AC-9 (RLS mọi bảng có tenant_id). Chạy: `make test` (supabase test db).
begin;
select no_plan();

-- ---------- dữ liệu nền (vai postgres) ----------
insert into auth.users (id, email, instance_id, aud, role) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'a@plat.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'b@plat.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
create temp table ids as
  select (select id from public.tenants where owner_user_id = 'aaaaaaaa-0000-0000-0000-0000000000a1') as ta,
         (select id from public.tenants where owner_user_id = 'bbbbbbbb-0000-0000-0000-0000000000b1') as tb;
grant select on ids to authenticated;

insert into public.signing_keys (key_id, public_key) values ('t-key', 'AAAA');
insert into public.apps (id, name, table_prefix, owner_tenant_id, visibility) values
  ('vn.app.pub1', 'Pub 1', 'app_vn_app_pub1', null, 'public'),
  ('vn.app.pub2', 'Pub 2', 'app_vn_app_pub2', null, 'public'),
  ('vn.app.pub3', 'Pub 3', 'app_vn_app_pub3', null, 'public'),
  ('vn.app.pub4', 'Pub 4', 'app_vn_app_pub4', null, 'public'),
  ('vn.app.priv-a', 'Riêng A', 'app_vn_app_priv_a', (select ta from ids), 'private');
insert into public.app_tables (app_id, table_name) values ('vn.app.priv-a', 'app_vn_app_priv_a_notes');

create function pg_temp.ver(p_app text, p_ver text, p_status text default 'draft') returns void language sql as $$
  insert into public.app_versions (app_id, version, package_path, sha256, signature, key_id, manifest, status)
  values (p_app, p_ver, p_app || '/' || p_ver || '.zip', repeat('a', 64), 'c2ln', 't-key', '{}', p_status)
$$;

-- Đóng vai người dùng đã đăng nhập: JWT có tenant_id + session_id. Luôn `reset role` trước khi gọi lại.
create function pg_temp.as_user(p_user uuid, p_tenant uuid, p_session uuid default null) returns void language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p_user,
    'tenant_id', p_tenant, 'session_id', p_session)::text, true);
end $$;

-- ---------- tenants / plans ----------
select is((select plan from public.tenants where id = (select ta from ids)), 'mvp-unlimited', 'tenant mới mặc định gói mvp-unlimited');
select is((select max_apps from public.plans where id = 'mvp-unlimited'), null, 'mvp-unlimited không giới hạn số app');

-- ---------- AC-1: gộp identity không sinh tenant thứ hai ----------
insert into auth.identities (provider_id, user_id, identity_data, provider)
  values ('g-123', 'aaaaaaaa-0000-0000-0000-0000000000a1', '{"sub":"g-123","email":"a@plat.test"}', 'google');
insert into auth.identities (provider_id, user_id, identity_data, provider)
  values ('ap-456', 'aaaaaaaa-0000-0000-0000-0000000000a1', '{"sub":"ap-456","email":"relay@privaterelay.appleid.com"}', 'apple');
select is((select count(*)::int from public.tenants where owner_user_id = 'aaaaaaaa-0000-0000-0000-0000000000a1'), 1,
  'gắn identity Google / Apple vào user có sẵn: vẫn một tenant');
select is((select count(*)::int from public.tenants where owner_user_id in
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'bbbbbbbb-0000-0000-0000-0000000000b1')), 2, 'tổng số tenant không tăng');

-- ---------- AC-2: thiết bị = phiên ----------
insert into auth.sessions (id, user_id, user_agent) values
  ('aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Máy 1'),
  ('aaaaaaaa-1111-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Máy 2'),
  ('bbbbbbbb-1111-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'Máy của B');
select is((select count(*)::int from public.devices where tenant_id = (select ta from ids)), 2, 'mỗi phiên đăng nhập một dòng devices');
select is((select user_agent from public.devices where session_id = 'aaaaaaaa-1111-0000-0000-000000000001'), 'Máy 1', 'ghi user_agent');
create temp table dev as
  select (select id from public.devices where session_id = 'aaaaaaaa-1111-0000-0000-000000000001') as a1,
         (select id from public.devices where session_id = 'aaaaaaaa-1111-0000-0000-000000000002') as a2;
grant select on dev to authenticated;

select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids), 'aaaaaaaa-1111-0000-0000-000000000001');
select is((select count(*)::int from public.devices), 2, 'tenant A liệt kê được thiết bị của mình');
select lives_ok($$select public.register_device('Pixel 7', 'android')$$, 'register_device cập nhật phiên hiện tại');
select is((select name from public.devices where id = (select a1 from dev)), 'Pixel 7', 'tên thiết bị đã ghi');
select throws_ok($$insert into public.devices (tenant_id, user_id, session_id) values ((select ta from ids), 'aaaaaaaa-0000-0000-0000-0000000000a1', gen_random_uuid())$$,
  '42501', null, 'tenant không INSERT trực tiếp vào devices');
select throws_ok($$update public.devices set name = 'x'$$, '42501', null, 'tenant không UPDATE trực tiếp devices');
reset role;

select pg_temp.as_user('bbbbbbbb-0000-0000-0000-0000000000b1', (select tb from ids), 'bbbbbbbb-1111-0000-0000-000000000001');
select is((select count(*)::int from public.devices where tenant_id = (select ta from ids)), 0, 'tenant B không thấy thiết bị của A');
select throws_ok($$select public.revoke_device((select a2 from dev))$$, 'P0001', 'DEVICE_NOT_FOUND',
  'B thu hồi thiết bị của A: DEVICE_NOT_FOUND');
reset role;
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-0000000000b1', (select tb from ids), 'aaaaaaaa-1111-0000-0000-000000000001');
select throws_ok($$select public.register_device('chiếm', 'x')$$, 'P0001', 'DEVICE_NOT_FOUND', 'register_device với phiên không thuộc tenant của JWT: DEVICE_NOT_FOUND');
reset role;
select is((select count(*)::int from auth.sessions where id = 'aaaaaaaa-1111-0000-0000-000000000002'), 1, 'phiên của A còn nguyên sau lần thử của B');

select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids), 'aaaaaaaa-1111-0000-0000-000000000001');
select lives_ok($$select public.revoke_device((select a2 from dev))$$, 'A thu hồi máy 2');
reset role;
select is((select count(*)::int from auth.sessions where id = 'aaaaaaaa-1111-0000-0000-000000000002'), 0, 'phiên máy 2 bị xoá → GoTrue từ chối refresh token của nó');
select is((select count(*)::int from auth.sessions where id = 'aaaaaaaa-1111-0000-0000-000000000001'), 1, 'phiên máy 1 vẫn còn');
select isnt((select revoked_at from public.devices where id = (select a2 from dev)), null, 'devices.revoked_at của máy 2 có giá trị');
select is((select revoked_at from public.devices where id = (select a1 from dev)), null, 'máy 1 chưa bị thu hồi');

-- ---------- AC-4/6: ràng buộc version ----------
select lives_ok($$select pg_temp.ver('vn.app.pub1', '1.0.0')$$, 'tạo draft 1.0.0');
select throws_ok($$select pg_temp.ver('vn.app.pub1', '1.0.0')$$, 'P0001', 'VERSION_NOT_GREATER', 'trùng version bị từ chối');
select throws_ok($$select pg_temp.ver('vn.app.pub1', '0.9.9')$$, 'P0001', 'VERSION_NOT_GREATER', 'version thấp hơn bị từ chối');
select lives_ok($$select pg_temp.ver('vn.app.pub1', '1.10.0')$$, 'so semver theo số: 1.10.0 > 1.0.0');
select throws_ok($$select pg_temp.ver('vn.app.pub1', '1.2.0')$$, 'P0001', 'VERSION_NOT_GREATER', '1.2.0 < 1.10.0 bị từ chối');

select pg_temp.ver('vn.app.pub3', '1.0.0');
update public.app_versions set status = 'published', published_at = now() where app_id = 'vn.app.pub3';
select throws_ok($$update public.app_versions set status = 'draft' where app_id = 'vn.app.pub3'$$, 'P0001', 'BAD_STATE', 'published không quay lại draft');
update public.app_versions set status = 'revoked', revoked_at = now() where app_id = 'vn.app.pub3';
select throws_ok($$update public.app_versions set status = 'published' where app_id = 'vn.app.pub3'$$, 'P0001', 'REVOKED_IS_FINAL', 'revoked không quay lại');
select throws_ok($$update public.app_versions set sha256 = repeat('b', 64) where app_id = 'vn.app.pub3'$$, 'P0001', 'VERSION_IMMUTABLE', 'sha256/chữ ký của version không đổi sau khi tạo');

-- ---------- AC-5: catalog theo tenant ----------
create function pg_temp.cat(p_tenant uuid) returns text language sql as $$
  select coalesce(string_agg(id || '@' || coalesce(version, 'null') || ':' || coalesce(status, '-') || case when installed then ':cài' else '' end,
                             ', ' order by id), '(rỗng)')
    from public.catalog_for(p_tenant) where id like 'vn.app.pub%' or id = 'vn.app.priv-a'
$$;
select is(pg_temp.cat((select ta from ids)), '(rỗng)', 'chưa có bản published / chưa được thử: catalog rỗng');
insert into public.app_version_testers (app_id, version, tenant_id) values ('vn.app.pub1', '1.0.0', (select ta from ids));
select is(pg_temp.cat((select ta from ids)), 'vn.app.pub1@1.0.0:draft', 'tenant thử thấy draft');
select is(pg_temp.cat((select tb from ids)), '(rỗng)', 'tenant không thử không thấy draft');
insert into public.app_version_testers (app_id, version, tenant_id) values ('vn.app.pub1', '1.10.0', (select ta from ids));
select is(pg_temp.cat((select ta from ids)), 'vn.app.pub1@1.10.0:draft', 'tenant thử thấy bản draft cao nhất');
update public.app_versions set status = 'published', published_at = now() where app_id = 'vn.app.pub1' and version = '1.0.0';
select is(pg_temp.cat((select tb from ids)), 'vn.app.pub1@1.0.0:published', 'sau promote: tenant khác thấy published');
select is(pg_temp.cat((select ta from ids)), 'vn.app.pub1@1.10.0:draft', 'tenant thử vẫn thấy draft cao hơn published');

select pg_temp.ver('vn.app.priv-a', '1.0.0', 'published');
select is(pg_temp.cat((select ta from ids)), 'vn.app.priv-a@1.0.0:published, vn.app.pub1@1.10.0:draft', 'app riêng hiện ở chủ sở hữu');
select is(pg_temp.cat((select tb from ids)), 'vn.app.pub1@1.0.0:published', 'app riêng của tenant khác không xuất hiện');

select pg_temp.as_user('bbbbbbbb-0000-0000-0000-0000000000b1', (select tb from ids), 'bbbbbbbb-1111-0000-0000-000000000001');
select throws_ok($$select public.install_app('vn.app.priv-a')$$, 'P0001', 'APP_NOT_AVAILABLE', 'B cài app riêng của A: APP_NOT_AVAILABLE');
select throws_ok($$select public.install_app('vn.app.khong-co')$$, 'P0001', 'APP_NOT_AVAILABLE', 'app không tồn tại: APP_NOT_AVAILABLE');
select throws_ok($$select public.install_app('vn.app.pub3')$$, 'P0001', 'APP_NOT_AVAILABLE', 'app chỉ còn bản thu hồi, chưa cài: APP_NOT_AVAILABLE');
select lives_ok($$select public.install_app('vn.app.pub1')$$, 'B cài app chung đã published');
select is((select version from public.installations where app_id = 'vn.app.pub1'), '1.0.0', 'installations ghi version đã cài');
reset role;

-- thu hồi bản duy nhất B được thấy
update public.app_versions set status = 'revoked', revoked_at = now() where app_id = 'vn.app.pub1' and version = '1.0.0';
select is(pg_temp.cat((select tb from ids)), 'vn.app.pub1@null:-:cài', 'thu hồi bản duy nhất: version null, vẫn báo cho tenant đã cài (NO_SAFE_VERSION)');
select is((select count(*)::int from public.installations where tenant_id = (select tb from ids)), 1, 'installations giữ nguyên, dữ liệu không mất');
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-0000000000b1', (select tb from ids), 'bbbbbbbb-1111-0000-0000-000000000001');
select throws_ok($$select public.install_app('vn.app.pub1')$$, 'P0001', 'NO_VERSION', 'cài lại app không còn bản an toàn: NO_VERSION');
reset role;
select is(pg_temp.cat((select ta from ids)), 'vn.app.priv-a@1.0.0:published, vn.app.pub1@1.10.0:draft', 'tenant thử không bị ảnh hưởng bởi thu hồi bản khác');

-- ---------- AC-7: quota ----------
insert into public.plans (id, name, max_apps) values ('test-2', 'Gói thử 2 app', 2);
update public.tenants set plan = 'test-2' where id = (select ta from ids);
select pg_temp.ver('vn.app.pub2', '1.0.0', 'published');
select pg_temp.ver('vn.app.pub4', '1.0.0', 'published');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids), 'aaaaaaaa-1111-0000-0000-000000000001');
select lives_ok($$select public.install_app('vn.app.pub1')$$, 'A cài app chung thứ 1 (draft vì là tester)');
select lives_ok($$select public.install_app('vn.app.pub2')$$, 'A cài app chung thứ 2');
select throws_ok($$select public.install_app('vn.app.pub4')$$, 'P0001', 'QUOTA_EXCEEDED', 'app chung thứ 3 vượt max_apps = 2: QUOTA_EXCEEDED');
select lives_ok($$select public.install_app('vn.app.priv-a')$$, 'app riêng không tính vào quota');
select lives_ok($$select public.install_app('vn.app.pub1')$$, 'cài lại app đã bật là idempotent, không tính hai lần');
select lives_ok($$select public.uninstall_app('vn.app.pub2')$$, 'gỡ app');
select is((select enabled from public.installations where app_id = 'vn.app.pub2'), false, 'gỡ = enabled false, dòng và dữ liệu giữ lại');
select lives_ok($$select public.install_app('vn.app.pub4')$$, 'gỡ bớt thì cài được app khác');
select throws_ok($$select public.uninstall_app('vn.app.pub3')$$, 'P0001', 'APP_NOT_INSTALLED', 'gỡ app chưa cài: APP_NOT_INSTALLED');
select throws_ok($$insert into public.installations (tenant_id, app_id) values ((select ta from ids), 'vn.app.pub3')$$, '42501', null, 'tenant không ghi trực tiếp installations (qua RPC)');
select throws_ok($$update public.installations set enabled = true$$, '42501', null, 'tenant không UPDATE trực tiếp installations');
reset role;
update public.tenants set plan = 'mvp-unlimited' where id = (select ta from ids);  -- registry set-plan
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids), 'aaaaaaaa-1111-0000-0000-000000000001');
select lives_ok($$select public.install_app('vn.app.pub2')$$, 'đổi sang mvp-unlimited: lần cài kế tiếp dùng gói mới');
reset role;

-- ---------- sổ bảng / registry không lộ ----------
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids), 'aaaaaaaa-1111-0000-0000-000000000001');
select is((select count(*)::int from public.app_tables where app_id = 'vn.app.priv-a'), 1, 'A thấy bảng của app riêng mình');
select is((select count(*)::int from public.app_tables where table_name = 'app_hello_items'), 1, 'A thấy bảng của app chung');
select throws_ok($$select * from public.apps$$, '42501', null, 'authenticated không đọc trực tiếp apps (qua catalog)');
select throws_ok($$select * from public.app_versions$$, '42501', null, 'authenticated không đọc trực tiếp app_versions');
select throws_ok($$select * from public.plans$$, '42501', null, 'authenticated không đọc plans');
select cmp_ok((select count(*)::int from public.signing_keys), '>=', 1, 'signing_keys đọc được (shell lấy khoá tin cậy)');
select throws_ok($$insert into public.signing_keys (key_id, public_key) values ('x', 'y')$$, '42501', null, 'authenticated không ghi signing_keys');
select throws_ok($$select public.catalog_for((select ta from ids))$$, '42501', null, 'authenticated không gọi catalog_for (chỉ service role)');
select throws_ok($$select public._install_app((select tb from ids), 'vn.app.pub2')$$, '42501', null, 'authenticated không gọi _install_app thay tenant khác');
reset role;
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-0000000000b1', (select tb from ids), 'bbbbbbbb-1111-0000-0000-000000000001');
select is((select count(*)::int from public.app_tables where app_id = 'vn.app.priv-a'), 0, 'B không thấy bảng của app riêng A');
reset role;

-- ---------- sync_rejections ----------
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids), 'aaaaaaaa-1111-0000-0000-000000000001');
select lives_ok($$insert into public.sync_rejections (tenant_id, table_name, row_id, op, code) values ((select ta from ids), 'app_hello_items', 'r1', 'PATCH', 'FORBIDDEN')$$,
  'A ghi hàng đợi lỗi của mình');
select throws_ok($$insert into public.sync_rejections (tenant_id, table_name, op, code) values ((select tb from ids), 'x', 'PATCH', 'FORBIDDEN')$$,
  '42501', null, 'A không ghi hàng đợi lỗi giả tenant B');
reset role;

select throws_ok($$insert into public.sync_rejections (tenant_id, table_name, row_id, op, code) values ((select ta from ids), 'app_hello_items', 'r1', 'PATCH', 'FORBIDDEN')$$,
  '23505', null, 'retry cùng một thay đổi hỏng không nhân bản dòng sync_rejections');

-- ---------- phiên đã thu hồi không ghi được qua RPC (JWT cũ còn hạn) ----------
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids), 'aaaaaaaa-1111-0000-0000-000000000002');
select throws_ok($$select public.install_app('vn.app.pub2')$$, 'P0001', 'SESSION_REVOKED', 'install_app bằng phiên đã thu hồi: SESSION_REVOKED');
select throws_ok($$select public.uninstall_app('vn.app.pub2')$$, 'P0001', 'SESSION_REVOKED', 'uninstall_app bằng phiên đã thu hồi: SESSION_REVOKED');
select throws_ok($$select public.revoke_device((select a1 from dev))$$, 'P0001', 'SESSION_REVOKED', 'revoke_device bằng phiên đã thu hồi: SESSION_REVOKED');
reset role;

-- ---------- updated_at do server ----------
insert into public.app_hello_items (id, tenant_id, title, updated_at)
  values ('cccccccc-0000-0000-0000-00000000000c', (select ta from ids), 'x', '2000-01-01');
select is((select updated_at from public.app_hello_items where id = 'cccccccc-0000-0000-0000-00000000000c'), now(), 'INSERT: updated_at = giờ server, giá trị client bị bỏ');
update public.app_hello_items set title = 'y', updated_at = '2001-01-01' where id = 'cccccccc-0000-0000-0000-00000000000c';
select is((select updated_at from public.app_hello_items where id = 'cccccccc-0000-0000-0000-00000000000c'), now(), 'UPDATE: updated_at = giờ server');

-- ---------- AC-9: RLS lặp MỌI bảng public có cột tenant_id ----------
-- Vòng 3: core_* có cột bắt buộc — chèn sẵn dòng của A để vòng lặp RLS bên dưới có dữ liệu thật.
insert into public.core_tags (id, tenant_id, name) values (gen_random_uuid(), (select ta from ids), 'việc nhà');
insert into public.core_contacts (id, tenant_id, name) values (gen_random_uuid(), (select ta from ids), 'Bố');
insert into public.core_files (id, tenant_id, app_id, name, storage_path)
  values (gen_random_uuid(), (select ta from ids), 'vn.app.hello', 'anh.jpg', (select ta from ids) || '/f1');

-- App mẫu đã seed (hello-cal có cột title bắt buộc): chèn sẵn một dòng của A nếu bảng có mặt.
do $$ begin
  if to_regclass('public.app_vn_app_hello_cal_reminders') is not null then
    insert into public.app_vn_app_hello_cal_reminders (id, tenant_id, title) values ('r-rls-a', (select ta from ids), 'nhắc thử');
  end if;
end $$;

create temp table tt as
  select c.table_name::text as t
    from information_schema.columns c join pg_tables p on p.schemaname = 'public' and p.tablename = c.table_name
   where c.table_schema = 'public' and c.column_name = 'tenant_id';
grant select on tt to authenticated;
create temp table rls_fail (t text, why text);
grant all on rls_fail to authenticated;

-- đảm bảo mỗi bảng có dữ liệu của A để phép đọc có ý nghĩa
do $$
declare r record; n int;
begin
  for r in select t from tt loop
    execute format('select count(*) from public.%I where tenant_id = %L', r.t, (select ta from ids)) into n;
    if n = 0 then
      -- Bảng của mini app đã publish (vd app riêng của seed) có thể đang rỗng: thêm một dòng của A trong transaction test.
      begin
        -- Cột bắt buộc không có default (vd title của app mẫu): điền giá trị theo kiểu.
        declare cols text := 'id, tenant_id'; vals text := format('gen_random_uuid(), %L', (select ta from ids)); c record;
        begin
          for c in select column_name, data_type from information_schema.columns
                    where table_schema = 'public' and table_name = r.t and is_nullable = 'NO' and column_default is null
                      and column_name not in ('id', 'tenant_id') loop
            cols := cols || ', ' || quote_ident(c.column_name);
            vals := vals || ', ' || case when c.data_type in ('integer', 'bigint', 'smallint', 'numeric') then '0'
                                         when c.data_type = 'uuid' then 'gen_random_uuid()'
                                         when c.data_type like 'timestamp%' then 'now()'
                                         when c.data_type = 'boolean' then 'false' else quote_literal('x') end;
          end loop;
          execute format('insert into public.%I (%s) values (%s)', r.t, cols, vals);
        end;
      exception when others then
        insert into rls_fail values (r.t, 'bảng không có dòng nào của A và không chèn được — test RLS vô nghĩa (' || sqlerrm || ')');
      end;
    end if;
  end loop;
end $$;

select pg_temp.as_user('bbbbbbbb-0000-0000-0000-0000000000b1', (select tb from ids), 'bbbbbbbb-1111-0000-0000-000000000001');
do $$
declare r record; n int; ta uuid := (select ta from ids);
begin
  for r in select t from tt loop
    begin
      execute format('select count(*) from public.%I where tenant_id = %L', r.t, ta) into n;
      if n > 0 then insert into rls_fail values (r.t, 'B đọc được ' || n || ' dòng của A'); end if;
    exception when insufficient_privilege then null; end;
    begin
      execute format('insert into public.%I (tenant_id) values (%L)', r.t, ta);
      insert into rls_fail values (r.t, 'INSERT giả tenant_id A lọt');
    exception when insufficient_privilege then null;
              when others then insert into rls_fail values (r.t, 'INSERT lỗi khác ' || sqlstate); end;
    begin
      execute format('update public.%I set tenant_id = tenant_id where tenant_id = %L', r.t, ta);
      get diagnostics n = row_count;
      if n > 0 then insert into rls_fail values (r.t, 'UPDATE chạm ' || n || ' dòng của A'); end if;
    exception when insufficient_privilege then null; end;
    begin
      execute format('delete from public.%I where tenant_id = %L', r.t, ta);
      get diagnostics n = row_count;
      if n > 0 then insert into rls_fail values (r.t, 'DELETE chạm ' || n || ' dòng của A'); end if;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;
select cmp_ok((select count(*)::int from tt), '>=', 5, 'có ít nhất 5 bảng mang tenant_id để lặp');
select is((select coalesce(string_agg(t || ': ' || why, '; '), '') from rls_fail), '', 'mọi bảng có tenant_id: B đọc 0 / INSERT giả bị chặn / UPDATE-DELETE 0 dòng của A');

-- ---------- Vòng 3: core_* ----------
select is((select count(*)::int from tt where t in ('core_tags', 'core_contacts', 'core_files')), 3, 'core_tags / core_contacts / core_files mang tenant_id và nằm trong vòng lặp RLS ở trên');
select is((select string_agg(table_name, ',' order by table_name) from public.app_tables where app_id = '_core'), 'core_contacts,core_files,core_tags', 'app_tables ghi sổ core_* với app_id = _core (upload nhận ghi)');
select is((select count(*)::int from public.catalog_for((select ta from ids)) where id = '_core'), 0, 'app ảo _core không bao giờ xuất hiện ở catalog');
select is((select count(*)::int from pg_publication_tables where pubname = 'powersync' and tablename in ('core_tags', 'core_contacts', 'core_files')), 3, 'core_* nằm trong publication powersync');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids));
select throws_ok($$delete from public.core_tags$$, '42501', null, 'client không có quyền DELETE cứng trên core_tags');
select throws_ok($$insert into public.core_files (id, tenant_id, app_id, name, storage_path, size) values (gen_random_uuid(), (select ta from ids), 'a', 'b', 'c', -1)$$, '23514', null, 'core_files.size âm bị CHECK chặn');
reset role;

-- ---------- Vòng 3: entitlement_until ----------
select is((select entitlement_until from public.tenants where id = (select ta from ids)), null, 'entitlement_until mặc định null (không hết hạn)');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids));
select is((select entitlement_until from public.tenants where id = (select ta from ids)), null, 'tenant đọc được entitlement_until của mình');
select throws_ok($$update public.tenants set entitlement_until = now() - interval '30 days'$$, '42501', null, 'tenant không tự đổi được entitlement_until');
reset role;

-- ---------- Vòng 3: reorder_apps ----------
insert into public.installations (tenant_id, app_id, version) values
  ((select ta from ids), 'vn.app.pub1', '1.0.0'), ((select ta from ids), 'vn.app.pub2', '1.0.0'), ((select ta from ids), 'vn.app.pub3', '1.0.0'),
  ((select tb from ids), 'vn.app.pub1', '1.0.0'), ((select tb from ids), 'vn.app.pub2', '1.0.0')
  on conflict (tenant_id, app_id) do update set position = null;
select is((select position from public.installations where tenant_id = (select ta from ids) and app_id = 'vn.app.pub1'), null, 'position mặc định null');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids));
select lives_ok($$select public.reorder_apps(array['vn.app.pub2', 'vn.app.pub1', 'vn.app.khong-co', 'vn.app.pub1'])$$, 'reorder_apps chạy được; app lạ và trùng bị bỏ qua');
select is((select string_agg(app_id || '=' || coalesce(position::text, 'null'), ',' order by app_id) from public.installations where app_id in ('vn.app.pub1', 'vn.app.pub2', 'vn.app.pub3')),
  'vn.app.pub1=1,vn.app.pub2=0,vn.app.pub3=null', 'position = chỉ số mảng (lần xuất hiện đầu), app không nêu giữ nguyên');
select throws_ok($$update public.installations set position = 9$$, '42501', null, 'ghi installations trực tiếp vẫn bị chặn (chỉ qua RPC)');
reset role;
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-0000000000b1', (select tb from ids));
select lives_ok($$select public.reorder_apps(array['vn.app.pub2', 'vn.app.pub1', 'vn.app.pub3'])$$, 'B gọi reorder_apps kèm app B chưa cài (pub3) → bỏ qua');
reset role;
select is((select string_agg(tenant_id::text || ':' || app_id || '=' || coalesce(position::text, 'null'), ',' order by tenant_id::text, app_id) from public.installations where app_id in ('vn.app.pub1', 'vn.app.pub2', 'vn.app.pub3')),
  (select string_agg(x, ',' order by x) from (
     select (select ta from ids)::text || ':vn.app.pub1=1' x union all select (select ta from ids)::text || ':vn.app.pub2=0'
     union all select (select ta from ids)::text || ':vn.app.pub3=null'
     union all select (select tb from ids)::text || ':vn.app.pub1=1' union all select (select tb from ids)::text || ':vn.app.pub2=0') q),
  'reorder_apps của B chỉ đổi installation của B, không đụng A');

-- ---------- Vòng 3: bucket Storage `files` ----------
select is((select public from storage.buckets where id = 'files'), false, 'bucket files là private');
insert into storage.objects (bucket_id, name) values
  ('files', (select ta from ids)::text || '/file-a'), ('files', (select tb from ids)::text || '/file-b'), ('packages', 'vn.app.pub1/1.0.0.zip');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', (select ta from ids));
select is((select string_agg(name, ',') from storage.objects where bucket_id = 'files'), (select ta from ids)::text || '/file-a', 'tenant A chỉ thấy thư mục của A trong bucket files');
select is((select count(*)::int from storage.objects where bucket_id = 'packages'), 0, 'tenant không đọc được bucket packages');
select lives_ok($$insert into storage.objects (bucket_id, name) values ('files', (select ta from ids)::text || '/file-a2')$$, 'A ghi vào thư mục của mình');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('files', (select tb from ids)::text || '/xam-nhap')$$, '42501', null, 'A không ghi được vào thư mục của B');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('files', 'khong-co-thu-muc-tenant')$$, '42501', null, 'đường dẫn không có thư mục tenant bị chặn');
select throws_ok($$update storage.objects set name = (select tb from ids)::text || '/doi-ten' where bucket_id = 'files' and name = (select ta from ids)::text || '/file-a2'$$, '42501', null, 'A không đổi tên object sang thư mục của B (WITH CHECK)');
create temp table upd_b (n int);
grant all on upd_b to authenticated;
do $$ declare c int; begin
  update storage.objects set metadata = '{}'::jsonb where bucket_id = 'files' and name like (select tb from ids)::text || '/%';
  get diagnostics c = row_count;
  insert into upd_b values (c);
end $$;
select is((select n from upd_b), 0, 'A không cập nhật được object của B');
reset role;
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-0000000000b1', (select tb from ids));
select is((select string_agg(name, ',') from storage.objects where bucket_id = 'files'), (select tb from ids)::text || '/file-b', 'tenant B chỉ thấy thư mục của B (không thấy file-a, file-a2)');
reset role;

select * from finish();
rollback;
