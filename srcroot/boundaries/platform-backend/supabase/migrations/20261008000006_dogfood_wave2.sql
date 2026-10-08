-- Dogfood đợt 2 vòng 2 (rushed + breaker). Chỉ cộng thêm / thay thế hàm.

-- 1. sync_rejections: retry cùng một thay đổi hỏng không nhân bản dòng (rushed #3).
delete from public.sync_rejections a using public.sync_rejections b
 where a.ctid > b.ctid and a.tenant_id = b.tenant_id and a.table_name = b.table_name
   and a.row_id is not distinct from b.row_id and a.op = b.op and a.code = b.code;
alter table public.sync_rejections
  add constraint sync_rejections_dedupe unique nulls not distinct (tenant_id, table_name, row_id, op, code);

-- 2. set_updated_at: UPDATE không đổi giá trị nào thì giữ nguyên updated_at (rushed #5 — replay lô không phát sinh thay đổi sync).
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    new.updated_at := old.updated_at;
    return new;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- 3. RPC ghi từ phiên đã bị thu hồi bị chặn ngay (rushed #7): JWT cũ còn hạn nhưng auth.sessions không còn.
create function public.assert_session_alive() returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
begin
  if sid is not null and not exists (select 1 from auth.sessions where id = sid) then
    raise exception using message = 'SESSION_REVOKED';
  end if;
end $$;
revoke all on function public.assert_session_alive() from public, anon;
grant execute on function public.assert_session_alive() to authenticated;

create or replace function public.install_app(p_app_id text) returns void
language plpgsql security definer set search_path = public as $$
declare tid uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
begin
  perform public.assert_session_alive();
  if tid is null then raise exception using message = 'NO_TENANT'; end if;
  perform public._install_app(tid, p_app_id);
end $$;

create or replace function public.uninstall_app(p_app_id text) returns void
language plpgsql security definer set search_path = public as $$
declare
  tid uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
  n   integer;
begin
  perform public.assert_session_alive();
  if tid is null then raise exception using message = 'NO_TENANT'; end if;
  update public.installations set enabled = false where tenant_id = tid and app_id = p_app_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception using message = 'APP_NOT_INSTALLED'; end if;
end $$;

create or replace function public.revoke_device(p_device_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  tid uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
  sid uuid;
begin
  perform public.assert_session_alive();
  select session_id into sid from public.devices
    where id = p_device_id and tenant_id = tid for update;
  if sid is null then raise exception using message = 'DEVICE_NOT_FOUND'; end if;
  update public.devices set revoked_at = coalesce(revoked_at, now()) where id = p_device_id;
  delete from auth.sessions where id = sid;
end $$;
