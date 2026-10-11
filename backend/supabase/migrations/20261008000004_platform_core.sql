-- Vòng 2 (W2): tầng platform. Migration chỉ cộng thêm. Ngôn ngữ lỗi: RPC `raise exception using message = '<CODE>'`.
-- Mọi bảng platform chỉ service role / security definer ghi; `authenticated` chỉ đọc phần của tenant mình.

-- ---------------------------------------------------------------------------------------------
-- plans · tenants.plan
-- ---------------------------------------------------------------------------------------------
create table public.plans (
  id          text primary key,
  name        text not null,
  max_apps    integer check (max_apps is null or max_apps >= 0),   -- NULL = không giới hạn
  price_month integer not null default 0,
  created_at  timestamptz not null default now()
);
alter table public.plans enable row level security;
revoke all on public.plans from anon, authenticated;
insert into public.plans (id, name, max_apps) values ('mvp-unlimited', 'MVP không giới hạn', null);

alter table public.tenants alter column plan set default 'mvp-unlimited';
update public.tenants set plan = 'mvp-unlimited' where plan = 'free';
alter table public.tenants add constraint tenants_plan_fk foreign key (plan) references public.plans (id);

-- ---------------------------------------------------------------------------------------------
-- set_updated_at: giờ SERVER, bỏ qua giá trị client (dogfood vòng 1: giờ máy có thể lùi)
-- ---------------------------------------------------------------------------------------------
create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger set_updated_at before insert or update on public.app_hello_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- devices: mỗi phiên GoTrue = một thiết bị
-- ---------------------------------------------------------------------------------------------
create table public.devices (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  user_id      uuid not null,
  session_id   uuid not null unique,                      -- = auth.sessions.id (không FK: phiên bị xoá khi thu hồi)
  name         text,
  platform     text,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz
);
create index devices_tenant on public.devices (tenant_id, created_at);
alter table public.devices enable row level security;
create policy devices_tenant_read on public.devices for select
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
revoke all on public.devices from anon, authenticated;
grant select on public.devices to authenticated;

create function public.on_session_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  select id into tid from public.tenants where owner_user_id = new.user_id;
  if tid is not null then
    insert into public.devices (tenant_id, user_id, session_id, user_agent)
      values (tid, new.user_id, new.id, new.user_agent)
      on conflict (session_id) do nothing;
  end if;
  return new;
end $$;
create trigger on_auth_session_created after insert on auth.sessions
  for each row execute function public.on_session_created();

-- Làm mới token → cập nhật last_seen_at; phiên kết thúc (đăng xuất / thu hồi) → đánh dấu revoked_at.
create function public.on_session_refreshed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.devices set last_seen_at = now() where session_id = new.id;
  return new;
end $$;
create trigger on_auth_session_refreshed after update of refreshed_at on auth.sessions
  for each row when (old.refreshed_at is distinct from new.refreshed_at)
  execute function public.on_session_refreshed();

create function public.on_session_deleted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.devices set revoked_at = coalesce(revoked_at, now()) where session_id = old.id;
  return old;
end $$;
create trigger on_auth_session_deleted after delete on auth.sessions
  for each row execute function public.on_session_deleted();

create function public.register_device(p_name text, p_platform text) returns void
language plpgsql security definer set search_path = public as $$
declare
  sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  tid uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
  n   integer;
begin
  update public.devices set name = left(p_name, 100), platform = left(p_platform, 30)
    where session_id = sid and tenant_id = tid and revoked_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception using message = 'DEVICE_NOT_FOUND'; end if;
end $$;

create function public.revoke_device(p_device_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  tid uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
  sid uuid;
begin
  select session_id into sid from public.devices
    where id = p_device_id and tenant_id = tid for update;
  if sid is null then raise exception using message = 'DEVICE_NOT_FOUND'; end if;
  update public.devices set revoked_at = coalesce(revoked_at, now()) where id = p_device_id;
  -- Xoá phiên → GoTrue từ chối refresh token của phiên này (token phiên khác không đụng tới).
  delete from auth.sessions where id = sid;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Registry: signing_keys · apps · app_versions · testers · app_tables · intent_schemas · app_migrations
-- ---------------------------------------------------------------------------------------------
create table public.signing_keys (
  key_id     text primary key,
  public_key text not null,                                -- base64 của 32 byte khoá công khai Ed25519
  status     text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now()
);
alter table public.signing_keys enable row level security;
create policy signing_keys_read on public.signing_keys for select to authenticated using (true);
revoke all on public.signing_keys from anon, authenticated;
grant select on public.signing_keys to authenticated;

create table public.apps (
  id              text primary key check (id ~ '^[a-z0-9]+(\.[a-z0-9-]+)+$'),
  name            text not null,
  table_prefix    text not null unique check (table_prefix ~ '^app_[a-z0-9_]+$' and char_length(table_prefix) <= 40),
  owner_tenant_id uuid references public.tenants (id),
  visibility      text not null default 'public' check (visibility in ('public', 'private')),
  created_at      timestamptz not null default now(),
  check ((visibility = 'private') = (owner_tenant_id is not null))
);
alter table public.apps enable row level security;
revoke all on public.apps from anon, authenticated;       -- không đọc trực tiếp; đi qua `catalog`

-- So sánh semver x.y.z (không prerelease) — dùng cho trigger VERSION_NOT_GREATER và chọn bản cao nhất.
create function public.semver_key(v text) returns integer[]
language sql immutable as $$
  select array[split_part(v, '.', 1)::int, split_part(v, '.', 2)::int, split_part(v, '.', 3)::int]
$$;

create table public.app_versions (
  app_id       text not null references public.apps (id),
  version      text not null check (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  sdk_range    text not null default '0',
  package_path text not null,
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  signature    text not null,
  key_id       text not null references public.signing_keys (key_id),
  manifest     jsonb not null,
  status       text not null default 'draft' check (status in ('draft', 'published', 'revoked')),
  created_at   timestamptz not null default now(),
  published_at timestamptz,
  revoked_at   timestamptz,
  primary key (app_id, version)
);
alter table public.app_versions enable row level security;
revoke all on public.app_versions from anon, authenticated;

create function public.app_versions_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.app_versions v
               where v.app_id = new.app_id
                 and public.semver_key(v.version) >= public.semver_key(new.version)) then
      raise exception using message = 'VERSION_NOT_GREATER';
    end if;
  else
    if old.status = 'revoked' and new.status <> 'revoked' then
      raise exception using message = 'REVOKED_IS_FINAL';
    end if;
    if old.status = 'published' and new.status = 'draft' then
      raise exception using message = 'BAD_STATE';
    end if;
    if (new.app_id, new.version, new.sha256, new.signature, new.package_path)
       is distinct from (old.app_id, old.version, old.sha256, old.signature, old.package_path) then
      raise exception using message = 'VERSION_IMMUTABLE';
    end if;
  end if;
  return new;
end $$;
create trigger app_versions_guard before insert or update on public.app_versions
  for each row execute function public.app_versions_guard();

create table public.app_version_testers (
  app_id    text not null,
  version   text not null,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  primary key (app_id, version, tenant_id),
  foreign key (app_id, version) references public.app_versions (app_id, version)
);
alter table public.app_version_testers enable row level security;
revoke all on public.app_version_testers from anon, authenticated;

create table public.app_tables (
  app_id     text not null references public.apps (id),
  table_name text primary key,
  created_at timestamptz not null default now()
);
alter table public.app_tables enable row level security;
-- `upload` (JWT người gọi) tra sổ này: chỉ thấy bảng của app công khai hoặc app riêng của tenant mình.
-- Hàm security definer vì `authenticated` không có quyền đọc `apps`.
create function public.app_visible_to_jwt(p_app_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.apps a
                  where a.id = p_app_id
                    and (a.owner_tenant_id is null
                         or a.owner_tenant_id = nullif(auth.jwt() ->> 'tenant_id', '')::uuid))
$$;
revoke all on function public.app_visible_to_jwt(text) from public, anon;
grant execute on function public.app_visible_to_jwt(text) to authenticated;
create policy app_tables_visible on public.app_tables for select to authenticated
  using (public.app_visible_to_jwt(app_id));
revoke all on public.app_tables from anon, authenticated;
grant select on public.app_tables to authenticated;

create table public.intent_schemas (
  type    text not null,
  version text not null,
  schema  jsonb not null,
  app_id  text not null references public.apps (id),
  primary key (type, version)
);
alter table public.intent_schemas enable row level security;
revoke all on public.intent_schemas from anon, authenticated;

-- Sổ migration của mini app đã áp (để publish idempotent và bản sau chỉ áp migration mới).
create table public.app_migrations (
  app_id     text not null references public.apps (id),
  filename   text not null,
  sha256     text not null,
  applied_at timestamptz not null default now(),
  primary key (app_id, filename)
);
alter table public.app_migrations enable row level security;
revoke all on public.app_migrations from anon, authenticated;

-- Hello là app đầu tiên trong registry (chủ dự án chốt giữ fixture, 2026-10-08).
insert into public.apps (id, name, table_prefix) values ('vn.app.hello', 'Hello', 'app_hello');
insert into public.app_tables (app_id, table_name) values ('vn.app.hello', 'app_hello_items');

-- ---------------------------------------------------------------------------------------------
-- installations · sync_rejections
-- ---------------------------------------------------------------------------------------------
create table public.installations (
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  app_id       text not null references public.apps (id),
  version      text,
  installed_at timestamptz not null default now(),
  enabled      boolean not null default true,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, app_id)
);
alter table public.installations enable row level security;
create policy installations_tenant_read on public.installations for select
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
revoke all on public.installations from anon, authenticated;
grant select on public.installations to authenticated;     -- ghi chỉ qua install_app / uninstall_app
create trigger set_updated_at before update on public.installations
  for each row execute function public.set_updated_at();

create table public.sync_rejections (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  table_name text not null,
  row_id     text,
  op         text not null,
  data       jsonb,
  code       text not null,
  detail     text,
  created_at timestamptz not null default now()
);
create index sync_rejections_tenant on public.sync_rejections (tenant_id, created_at);
alter table public.sync_rejections enable row level security;
create policy sync_rejections_tenant on public.sync_rejections
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
revoke all on public.sync_rejections from anon, authenticated;
grant select, insert on public.sync_rejections to authenticated;

-- PowerSync đọc `installations` (tham số bucket) và `sync_rejections` (bucket rejections) qua publication.
alter publication powersync add table public.installations, public.sync_rejections;

-- ---------------------------------------------------------------------------------------------
-- Catalog theo tenant + cài / gỡ app (quota)
-- ---------------------------------------------------------------------------------------------
-- Bản "an toàn" cho tenant: published chưa thu hồi cao nhất, hoặc bản draft cao hơn nếu tenant là tester.
-- App xuất hiện khi: có bản an toàn, hoặc tenant đã có dòng installations (để báo NO_SAFE_VERSION).
create function public.catalog_for(p_tenant uuid) returns table (
  id text, name text, table_prefix text, owner_tenant_id uuid,
  version text, sdk_range text, package_path text, sha256 text, signature text, key_id text,
  status text, installed boolean, enabled boolean
)
language sql stable security definer set search_path = public as $$
  select a.id, a.name, a.table_prefix, a.owner_tenant_id,
         v.version, v.sdk_range, v.package_path, v.sha256, v.signature, v.key_id,
         v.status,
         (i.app_id is not null), coalesce(i.enabled, false)
    from public.apps a
    left join public.installations i on i.app_id = a.id and i.tenant_id = p_tenant
    left join lateral (
      select av.* from public.app_versions av
       where av.app_id = a.id
         and (av.status = 'published'
              or (av.status = 'draft' and exists (
                    select 1 from public.app_version_testers t
                     where t.app_id = av.app_id and t.version = av.version and t.tenant_id = p_tenant)))
       order by public.semver_key(av.version) desc
       limit 1
    ) v on true
   where (a.owner_tenant_id is null or a.owner_tenant_id = p_tenant)
     and (v.version is not null or i.app_id is not null)
   order by a.id
$$;
revoke all on function public.catalog_for(uuid) from public, anon, authenticated;
grant execute on function public.catalog_for(uuid) to service_role;

-- Lõi cài đặt (không kiểm JWT): seed và pgTAP gọi trực tiếp; RPC `install_app` bọc lại bằng tenant từ JWT.
create function public._install_app(p_tenant uuid, p_app text) returns void
language plpgsql security definer set search_path = public as $$
declare
  c        record;
  v_max    integer;
  v_count  integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('install:' || p_tenant::text, 0));
  select * into c from public.catalog_for(p_tenant) cf where cf.id = p_app;
  if not found then raise exception using message = 'APP_NOT_AVAILABLE'; end if;
  if c.version is null then raise exception using message = 'NO_VERSION'; end if;

  if c.owner_tenant_id is null
     and not exists (select 1 from public.installations
                      where tenant_id = p_tenant and app_id = p_app and enabled) then
    select p.max_apps into v_max from public.tenants t join public.plans p on p.id = t.plan where t.id = p_tenant;
    if v_max is not null then
      select count(*) into v_count
        from public.installations i join public.apps a on a.id = i.app_id
       where i.tenant_id = p_tenant and i.enabled and a.owner_tenant_id is null;
      if v_count >= v_max then raise exception using message = 'QUOTA_EXCEEDED'; end if;
    end if;
  end if;

  insert into public.installations (tenant_id, app_id, version, enabled)
    values (p_tenant, p_app, c.version, true)
    on conflict (tenant_id, app_id) do update set version = excluded.version, enabled = true;
end $$;
revoke all on function public._install_app(uuid, text) from public, anon, authenticated;
grant execute on function public._install_app(uuid, text) to service_role;

create function public.install_app(p_app_id text) returns void
language plpgsql security definer set search_path = public as $$
declare tid uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
begin
  if tid is null then raise exception using message = 'NO_TENANT'; end if;
  perform public._install_app(tid, p_app_id);
end $$;

create function public.uninstall_app(p_app_id text) returns void
language plpgsql security definer set search_path = public as $$
declare
  tid uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
  n   integer;
begin
  if tid is null then raise exception using message = 'NO_TENANT'; end if;
  update public.installations set enabled = false where tenant_id = tid and app_id = p_app_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception using message = 'APP_NOT_INSTALLED'; end if;
end $$;

-- RPC mặc định cho PUBLIC thực thi → thu lại, chỉ cấp cho người đăng nhập.
revoke all on function public.register_device(text, text) from public, anon;
revoke all on function public.revoke_device(uuid) from public, anon;
revoke all on function public.install_app(text) from public, anon;
revoke all on function public.uninstall_app(text) from public, anon;
grant execute on function public.register_device(text, text) to authenticated;
grant execute on function public.revoke_device(uuid) to authenticated;
grant execute on function public.install_app(text) to authenticated;
grant execute on function public.uninstall_app(text) to authenticated;
