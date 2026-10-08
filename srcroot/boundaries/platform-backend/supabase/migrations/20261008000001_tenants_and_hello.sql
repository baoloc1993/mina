-- Vòng 1 (W1 spike): chỉ `tenants` + `app_hello_items`. Migration chỉ cộng thêm.
-- Luật chung bảng sync: id UUID sinh phía client, tenant_id, created_at, updated_at, deleted_at.

create table public.tenants (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users (id) on delete cascade,
  plan          text not null default 'free',
  created_at    timestamptz not null default now()
);
alter table public.tenants enable row level security;
-- Người dùng chỉ đọc được tenant của chính mình; không ghi trực tiếp (tạo qua trigger).
create policy tenant_self_read on public.tenants for select
  using (id = (auth.jwt() ->> 'tenant_id')::uuid);

-- 1 user = 1 tenant (MVP): tạo ngay khi user được tạo.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.tenants (owner_user_id) values (new.id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Custom access token hook: gắn claim tenant_id vào JWT (tenant_id không bao giờ do client khai).
create function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  claims jsonb := event -> 'claims';
  tid uuid;
begin
  select id into tid from public.tenants where owner_user_id = (event ->> 'user_id')::uuid;
  if tid is not null then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(tid::text));
  end if;
  return jsonb_set(event, '{claims}', claims);
end $$;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant select on public.tenants to supabase_auth_admin;
create policy tenant_auth_admin_read on public.tenants as permissive for select
  to supabase_auth_admin using (true);

-- Bảng của fixture vn.app.hello (xoá/giữ ở vòng 2).
create table public.app_hello_items (
  id         uuid primary key,
  tenant_id  uuid not null references public.tenants (id),
  title      text not null,
  done       boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index app_hello_items_tenant_updated on public.app_hello_items (tenant_id, updated_at);
alter table public.app_hello_items enable row level security;
create policy tenant_isolation on public.app_hello_items
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
revoke all on public.app_hello_items from anon, authenticated;
grant select, insert, update on public.app_hello_items to authenticated;
-- Không cấp DELETE: xoá từ mini app luôn là xoá mềm (UPDATE deleted_at).
