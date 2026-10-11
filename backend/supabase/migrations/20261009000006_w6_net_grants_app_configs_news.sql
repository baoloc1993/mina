-- Vòng 6 (W6) — phần server cộng thêm cho Đọc báo + domain do người dùng cho phép + cấu hình app từ server.
-- Chỉ cộng thêm (BACKWARD-COMPATIBILITY-CHECKLIST §2): shell vòng 1–5 không biết các bảng/trường này và vẫn chạy.
--   1. core_net_grants   — domain người dùng cho phép theo app × tenant (sync, bucket `core`, xoá mềm = thu hồi)
--   2. app_configs       — cấu hình app do người vận hành đặt (chỉ service role ghi; đi ra qua `catalog`)
--   3. ensure_news_limits() — CHECK NOT VALID cho 2 bảng Đọc báo (bảng do `registry publish` dựng nên đặt ở đây, như W4/W5)
--   4. purge_news_items() + pg_cron — dọn cache bài > 30 ngày (không đụng bài đọc sau)

-- ---------------------------------------------------------------------------------------------
-- 1. core_net_grants — luật chung bảng sync (ARCHITECTURE §6): RLS tenant_isolation, không DELETE, set_updated_at, publication, app_tables `_core`
-- ---------------------------------------------------------------------------------------------
create table public.core_net_grants (
  id         uuid primary key,
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  app_id     text not null check (char_length(app_id) <= 64 and app_id ~ '^[a-z0-9]+(\.[a-z0-9-]+)+$'),
  host       text not null check (char_length(host) <= 253 and host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index core_net_grants_tenant_updated on public.core_net_grants (tenant_id, updated_at);
create index core_net_grants_app_host on public.core_net_grants (tenant_id, app_id, host);
alter table public.core_net_grants enable row level security;
create policy tenant_isolation on public.core_net_grants
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
revoke all on public.core_net_grants from anon, authenticated;
grant select, insert, update on public.core_net_grants to authenticated;       -- không DELETE: thu hồi là xoá mềm
create trigger set_updated_at before insert or update on public.core_net_grants
  for each row execute function public.set_updated_at();
alter publication powersync add table public.core_net_grants;
insert into public.app_tables (app_id, table_name) values ('_core', 'core_net_grants') on conflict (table_name) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 2. app_configs — cấu hình app từ server. Không tenant, không sync; `catalog` (service role) đọc rồi trả trong catalog.apps[].config.
-- ---------------------------------------------------------------------------------------------
create table public.app_configs (
  app_id     text primary key references public.apps (id) on delete cascade,
  config     jsonb not null default '{}'::jsonb
             check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 65536),
  updated_at timestamptz not null default now()
);
alter table public.app_configs enable row level security;                       -- không policy nào ⇒ authenticated/anon không đọc/ghi
revoke all on public.app_configs from anon, authenticated;
grant select, insert, update, delete on public.app_configs to service_role;
create trigger set_updated_at before insert or update on public.app_configs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- 3. ensure_news_limits() — idempotent; chạy lại sau mỗi `registry publish` dựng bảng. NOT VALID: chỉ kiểm dòng mới/sửa. NULL luôn qua.
--    Vi phạm → `upload` trả REJECTED/SCHEMA.
-- ---------------------------------------------------------------------------------------------
create or replace function public.ensure_news_limits() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n integer := 0;
  spec record;
begin
  for spec in
    select * from (values
      ('app_vn_app_news_sources', 'app_vn_app_news_sources_limits',
       'char_length(name) <= 100 and char_length(feed_url) <= 2048 and char_length(host) <= 253 '
       'and host ~ ''^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'' '
       'and position >= 0 and char_length(suggested_key) <= 64 and char_length(last_error) <= 300 '
       'and last_fetched_at_ms between 0 and 4102444800000'),
      ('app_vn_app_news_items', 'app_vn_app_news_items_limits',
       'char_length(title) <= 300 and char_length(summary) <= 2000 and char_length(link) <= 2048 '
       'and char_length(guid) <= 2048 and char_length(image_url) <= 2048 and char_length(source_id) <= 64 '
       'and published_at_ms between 0 and 4102444800000 and fetched_at_ms between 0 and 4102444800000 '
       'and read_at_ms between 0 and 4102444800000 and saved_at_ms between 0 and 4102444800000 '
       'and (note_id is null or note_id ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'')')
    ) as t(tbl, con, cond)
  loop
    if to_regclass('public.' || spec.tbl) is not null
       and not exists (select 1 from pg_constraint where conname = spec.con and conrelid = to_regclass('public.' || spec.tbl)) then
      execute format('alter table public.%I add constraint %I check (%s) not valid', spec.tbl, spec.con, spec.cond);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.ensure_news_limits() from public, anon, authenticated;
grant execute on function public.ensure_news_limits() to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. purge_news_items() — xoá mềm bài cache quá 30 ngày mà chưa "đọc sau". Cần CẢ HAI mốc quá 30 ngày:
--    `fetched_at_ms` (đồng hồ máy khách) và `updated_at` (giờ server) — máy lệch giờ không làm xoá sớm (cùng quy tắc W4).
--    Bảng chưa tồn tại → 0. Bài đọc sau (`saved_at_ms` không null) không bao giờ bị dọn.
-- ---------------------------------------------------------------------------------------------
create or replace function public.purge_news_items() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer := 0;
begin
  if to_regclass('public.app_vn_app_news_items') is null then
    return 0;
  end if;
  execute $q$
    with doomed as (
      update public.app_vn_app_news_items
         set deleted_at = now()
       where deleted_at is null
         and saved_at_ms is null
         and fetched_at_ms < (extract(epoch from now() - interval '30 days') * 1000)::bigint
         and updated_at < now() - interval '30 days'
      returning 1)
    select count(*) from doomed
  $q$ into n;
  return n;
end $$;
revoke all on function public.purge_news_items() from public, anon, authenticated;
grant execute on function public.purge_news_items() to service_role;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('purge-news-items', '0 3 * * *', 'select public.purge_news_items()');
exception when others then
  raise notice 'pg_cron không khả dụng, bỏ qua lịch dọn bài Đọc báo: %', sqlerrm;
end $$;

select public.ensure_news_limits();
