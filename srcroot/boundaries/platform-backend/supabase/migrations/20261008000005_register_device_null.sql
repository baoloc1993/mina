-- Dogfood vòng 2 (picky R1): register_device với tên/nền tảng null không được xoá giá trị đã có.
create or replace function public.register_device(p_name text, p_platform text) returns void
language plpgsql security definer set search_path = public as $$
declare
  sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  tid uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
  n   integer;
begin
  update public.devices
     set name     = coalesce(nullif(btrim(left(p_name, 100)), ''), name),
         platform = coalesce(nullif(btrim(left(p_platform, 30)), ''), platform)
   where session_id = sid and tenant_id = tid and revoked_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception using message = 'DEVICE_NOT_FOUND'; end if;
end $$;
