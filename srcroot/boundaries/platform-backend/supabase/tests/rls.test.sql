-- AC-3 (DB): tenant B không đọc/ghi được dòng của tenant A; client không xoá cứng được.
begin;
select plan(5);

insert into auth.users (id, email, instance_id, aud, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@rls.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'b@rls.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

-- tenant được tạo tự động bởi trigger
select is((select count(*)::int from public.tenants where owner_user_id in
  ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001')), 2, 'mỗi user có một tenant');

create temp table ids as
  select (select id from public.tenants where owner_user_id = 'aaaaaaaa-0000-0000-0000-000000000001') as ta,
         (select id from public.tenants where owner_user_id = 'bbbbbbbb-0000-0000-0000-000000000001') as tb;
grant select on ids to authenticated;

insert into public.app_hello_items (id, tenant_id, title)
  select 'cccccccc-0000-0000-0000-000000000001', ta, 'của A' from ids;

-- Đóng vai tenant B
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('role','authenticated','sub','bbbbbbbb-0000-0000-0000-000000000001','tenant_id',(select tb from ids))::text, true);

select is((select count(*)::int from public.app_hello_items), 0, 'tenant B đọc 0 dòng của tenant A');
select throws_ok($$insert into public.app_hello_items (id, tenant_id, title)
  values ('dddddddd-0000-0000-0000-000000000001', (select ta from ids), 'bơm vào A')$$,
  '42501', null, 'tenant B không ghi được vào tenant A (WITH CHECK)');
create temp table upd_count (n int);
grant all on upd_count to authenticated;
do $$ declare c int; begin
  update public.app_hello_items set title = 'bị sửa';
  get diagnostics c = row_count;
  insert into upd_count values (c);
end $$;
select is((select n from upd_count), 0, 'tenant B không sửa được dòng của A');
select throws_ok($$delete from public.app_hello_items$$, '42501', null, 'client không có quyền DELETE cứng');

select * from finish();
rollback;
