-- Vòng 3 (W3): phần server cộng thêm — dữ liệu dùng chung `core_*`, bucket Storage `files`, thứ tự launcher, entitlement.
-- Migration chỉ cộng thêm (BACKWARD-COMPATIBILITY-CHECKLIST §2): shell vòng 1/2 vẫn chạy nguyên.

-- ---------------------------------------------------------------------------------------------
-- 1. Dòng `apps` ảo `_core` để `app_tables` (FK → apps) ghi sổ được bảng core_*.
--    `_core` không có version nên không bao giờ xuất hiện ở catalog_for; CLI list / gen-sync-rules bỏ qua nó.
--    Hai ràng buộc định dạng nới đúng một giá trị ngoại lệ (id `_core`, table_prefix `core`);
--    manifest của mini app vẫn bị CLI chặn theo regex gốc nên không ai publish được app trùng tên này.
-- ---------------------------------------------------------------------------------------------
alter table public.apps drop constraint apps_id_check;
alter table public.apps add constraint apps_id_check
  check (id = '_core' or id ~ '^[a-z0-9]+(\.[a-z0-9-]+)+$');
alter table public.apps drop constraint apps_table_prefix_check;
alter table public.apps add constraint apps_table_prefix_check
  check (table_prefix = 'core' or (table_prefix ~ '^app_[a-z0-9_]+$' and char_length(table_prefix) <= 40));
insert into public.apps (id, name, table_prefix) values ('_core', 'Dữ liệu dùng chung (core)', 'core')
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 2. core_tags · core_contacts · core_files — luật chung bảng sync (ARCHITECTURE §6)
-- ---------------------------------------------------------------------------------------------
create table public.core_tags (
  id         uuid primary key,
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (char_length(name) <= 200),
  color      text check (color is null or char_length(color) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table public.core_contacts (
  id         uuid primary key,
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (char_length(name) <= 200),
  phone      text check (phone is null or char_length(phone) <= 60),
  email      text check (email is null or char_length(email) <= 320),
  note       text check (note is null or char_length(note) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table public.core_files (
  id           uuid primary key,
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  app_id       text not null check (char_length(app_id) <= 100),
  name         text not null check (char_length(name) <= 255),
  mime         text not null default 'application/octet-stream' check (char_length(mime) <= 127),
  size         bigint not null default 0 check (size >= 0),
  storage_path text not null check (char_length(storage_path) <= 300),
  uploaded_at  timestamptz,                                   -- null = chưa upload lên bucket `files`
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['core_tags', 'core_contacts', 'core_files'] loop
    execute format('create index %I on public.%I (tenant_id, updated_at)', t || '_tenant_updated', t);
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
      with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)$p$, t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);   -- không DELETE: xoá là xoá mềm
    execute format('create trigger set_updated_at before insert or update on public.%I for each row execute function public.set_updated_at()', t);
    execute format('alter publication powersync add table public.%I', t);
    insert into public.app_tables (app_id, table_name) values ('_core', t) on conflict (table_name) do nothing;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. installations.position + reorder_apps · tenants.entitlement_until
-- ---------------------------------------------------------------------------------------------
alter table public.installations add column position integer;           -- null = chưa xếp, launcher đặt cuối theo installed_at

create function public.reorder_apps(p_app_ids text[]) returns void
language plpgsql security definer set search_path = public as $$
declare tid uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
begin
  perform public.assert_session_alive();
  if tid is null then raise exception using message = 'NO_TENANT'; end if;
  -- position = chỉ số (từ 0) của lần xuất hiện đầu tiên trong mảng; app lạ / của tenant khác bị bỏ qua.
  update public.installations i set position = o.pos
    from (select app_id, (min(ord) - 1)::integer as pos
            from unnest(coalesce(p_app_ids, '{}'::text[])) with ordinality as u(app_id, ord)
           group by app_id) o
   where i.tenant_id = tid and i.app_id = o.app_id;
end $$;
revoke all on function public.reorder_apps(text[]) from public, anon;
grant execute on function public.reorder_apps(text[]) to authenticated;

alter table public.tenants add column entitlement_until timestamptz;    -- null = không hết hạn; chỉ CLI set-entitlement đổi
-- `authenticated` chỉ cần ĐỌC tenant của mình (RLS tenant_self_read); trước đây còn thừa INSERT/UPDATE/DELETE/TRUNCATE mặc định.
revoke all on public.tenants from anon, authenticated;
grant select on public.tenants to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Bucket Storage `files` (private) — đường dẫn `<tenant_id>/<file_id>`
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
  values ('files', 'files', false, 52428800)                           -- 50 MB: khớp giới hạn file của shell
  on conflict (id) do nothing;

create policy files_tenant_select on storage.objects for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id'));
create policy files_tenant_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id'));
create policy files_tenant_update on storage.objects for update to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id'))
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id'));
-- Không có policy DELETE: client không xoá object (file_id không tái dùng; dọn do vận hành).
