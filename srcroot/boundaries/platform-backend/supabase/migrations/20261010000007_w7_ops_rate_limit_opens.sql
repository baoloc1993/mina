-- Vòng 7 (W7) — phát hành dùng thật. Chỉ CỘNG THÊM (BACKWARD-COMPATIBILITY-CHECKLIST §1 "Vòng 7 chạm surface"):
--   1. rate_limits + hit_rate_limit() — trần số lần gọi mỗi phút theo user cho upload / issue-app-token / catalog
--   2. purge_rate_limits() + pg_cron hằng giờ — dọn dòng đếm cũ
--   3. app_opens_daily + record_app_open() — số ngày P1 mở app (số đo H3, `PRD.md §6`)
-- Không đổi bảng/hàm/API nào đã giao ở vòng 1–6.

-- ---------------------------------------------------------------------------------------------
-- 1. rate_limits: cửa sổ cố định. key = '<chức năng>:<user_id>'. Chỉ service role (Edge Function) chạm.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.rate_limits (
  key          text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (key, window_start)
);
alter table public.rate_limits enable row level security;
revoke all on table public.rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.rate_limits to service_role;

-- Trả (allowed, count, retry_after_s). Đếm trước, xử lý sau: vượt trần → allowed = false, vẫn tăng count
-- (người spam không "xả" được trần bằng cách bị từ chối). retry_after_s = số giây tới hết cửa sổ hiện tại.
create or replace function public.hit_rate_limit(p_key text, p_window_s integer, p_max integer)
returns table (allowed boolean, hits integer, retry_after_s integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w_start timestamptz;
  c integer;
begin
  if p_key is null or p_key = '' or p_window_s < 1 or p_max < 1 then
    raise exception 'BAD_RATE_LIMIT_ARGS';
  end if;
  w_start := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);
  insert into public.rate_limits as r (key, window_start, count) values (p_key, w_start, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into c;
  allowed := c <= p_max;
  hits := c;
  retry_after_s := greatest(1, ceil(extract(epoch from (w_start + make_interval(secs => p_window_s) - now())))::integer);
  return next;
end $$;
revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;

create or replace function public.purge_rate_limits() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.rate_limits where window_start < now() - interval '1 hour';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_rate_limits() from public, anon, authenticated;
grant execute on function public.purge_rate_limits() to service_role;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('purge-rate-limits', '7 * * * *', 'select public.purge_rate_limits()');
exception when others then
  raise notice 'pg_cron không khả dụng, bỏ qua lịch dọn rate_limits: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. app_opens_daily: số lần cấp app token mỗi (tenant, app, ngày giờ Việt Nam). RLS: tenant đọc của mình;
--    chỉ record_app_open() (service role) ghi. Không sync xuống máy.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.app_opens_daily (
  tenant_id uuid        not null references public.tenants (id) on delete cascade,
  app_id    text        not null check (char_length(app_id) between 3 and 64),
  day       date        not null,
  opens     integer     not null default 1 check (opens >= 1),
  first_at  timestamptz not null default now(),
  last_at   timestamptz not null default now(),
  primary key (tenant_id, app_id, day)
);
alter table public.app_opens_daily enable row level security;
revoke all on table public.app_opens_daily from public, anon, authenticated;
grant select on table public.app_opens_daily to authenticated;
grant select, insert, update on table public.app_opens_daily to service_role;
drop policy if exists tenant_read on public.app_opens_daily;
create policy tenant_read on public.app_opens_daily for select to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

create or replace function public.record_app_open(p_tenant uuid, p_app text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.app_opens_daily as o (tenant_id, app_id, day)
  values (p_tenant, p_app, (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  on conflict (tenant_id, app_id, day) do update set opens = o.opens + 1, last_at = now();
$$;
revoke all on function public.record_app_open(uuid, text) from public, anon, authenticated;
grant execute on function public.record_app_open(uuid, text) to service_role;
