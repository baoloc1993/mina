# platform-backend — backend nền tảng mini app

Supabase (Postgres + RLS, Auth, Storage, Edge Functions) + PowerSync.

## Chạy local

```bash
make dev                                   # từ gốc repo: Supabase + PowerSync + khoá ký thử
python deployment/local/seed/seed.py       # 2 tenant (a@test.local, b@test.local) + hello, hello-cal, app riêng của a, hello 0.3.0 draft (migration lỗi), core_tags mẫu; chạy lại an toàn
make test                                  # pgTAP + deno + node + Jest
make accept                                # acceptance HTTP AC-1..AC-10 trên backend đang chạy
```

Sửa Edge Function xong phải `docker restart supabase_edge_runtime_platform-backend` (runtime không tự nạp lại).

## Phát hành mini app (dành cho dev — persona P4)

Mọi thao tác đi qua CLI `registry`, chạy **từ thư mục này**, trên máy có service key (không bao giờ trong shell/app):

```bash
cd backend
npm run registry                           # xem mọi lệnh
```

1. **Khoá ký** — `make dev` đã sinh `deployment/local/keys/signing-local-1.pem` (gitignore). `keygen` chỉ cần chạy khi chưa có và **không ghi đè** khoá sẵn có.
2. **Chuẩn bị thư mục app** — `manifest.json` và file `entry` **cạnh nhau**; migration (nếu có) ở `migrations/*.sql`. Nếu app có bước build, publish thư mục đã build.

   ```json
   { "id": "vn.app.note", "name": "Ghi chú", "version": "0.1.0", "sdk": "^0.1",
     "entry": "index.html", "scopes": ["db.own"], "tables": ["notes"] }
   ```

   - Manifest v0: `sdk` là semver range (hoặc `"0"` của hello cũ); `scopes` chỉ gồm `db`, `db.own`, `core.tags|contacts|files:read|write`, `intent.send`, `notify.local`, `storage.files`, `net`, `ui.native`, `auth.token` (scope lạ → `BAD_MANIFEST`); tuỳ chọn `icon`, `description`, `offline`, `network` (host chữ thường, không wildcard); `intents` là mảng `{type, version, schema}` (= nhận) hoặc object `{ sends: [{type, version}], receives: [...] }`. `catalog` trả lại `description`, `scopes`, `network` để shell hiện trước khi cài.

   - `id`: reverse-domain chữ thường; không bao giờ đổi. `version`: semver `x.y.z`, **mỗi lần publish phải lớn hơn** bản đã có.
   - `tables`: tên ngắn; bảng thật là `<table_prefix>_<tên>` (mặc định `app_` + id đổi `.`/`-` thành `_`, vd `app_vn_app_note_notes`).
   - `migrations/*.sql` **đi cùng gói zip** (từ vòng 3, shell chạy cùng file trong SQLite để dựng schema cục bộ): dùng TÊN BẢNG ĐẦY ĐỦ có tiền tố (vd `app_hello_items`) và kiểu portable cho cả Postgres lẫn SQLite.
   - Migration chỉ được **cộng thêm** trên bảng của app: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` (nullable hoặc có DEFAULT), `CREATE INDEX`. Chỉ khai `CREATE TABLE` — CLI tự thêm `tenant_id`, `created_at`, `updated_at`, `deleted_at`, RLS, trigger giờ server và đưa bảng vào sync. Đã áp rồi thì không sửa file cũ — thêm file mới.
3. **Publish → thử → công bố**

   ```bash
   npm run registry -- publish ./my-app                      # → bản draft (thêm --owner <email> nếu là app riêng của một tenant)
   npm run registry -- add-tester vn.app.note 0.1.0 a@test.local   # tenant này thấy bản draft
   npm run registry -- list                                  # kiểm trạng thái
   npm run registry -- promote vn.app.note 0.1.0             # công bố cho mọi tenant
   npm run registry -- set-entitlement a@test.local 2026-09-01   # hạn gói của tenant; quá hạn + 7 ngày ân hạn → upload 403 READ_ONLY
   npm run registry -- set-entitlement a@test.local null         # bỏ hạn (mặc định của mọi tenant)
   npm run registry -- gen-sync-rules                        # có bảng mới? báo có đổi không + lệnh restart PowerSync
   npm run registry -- revoke vn.app.note 0.1.0              # bản lỗi: thu hồi (không quay lại được)
   ```

4. **Kiểm catalog** — `GET /functions/v1/catalog` với JWT của tenant (xem `scripts/acceptance.ts`, hàm `extraSession`, để lấy JWT thử cho `a@test.local` bằng admin `generate_link`).

Gói hello (fixture của shell) có `entry` trong `src/` nên **không publish thẳng được** — `seed.py` dựng thư mục tạm; app mới đặt `entry` cạnh `manifest.json`.

## Mã lỗi

Edge Functions: `{ "error": "<CODE>", "detail"?: "…" }` với HTTP status đúng nghĩa. RPC Postgres (`install_app`, `revoke_device`…): PostgREST luôn trả **HTTP 400** với `{ "message": "<CODE>" }` — chỉ tin `message`, không tin status. Danh sách mã: `ARCHITECTURE.md §5`.

## Vòng 3 — dữ liệu dùng chung, file, entitlement

- **`core_tags` / `core_contacts` / `core_files`**: bảng sync dùng chung trong tenant (luật chung bảng sync, RLS `tenant_isolation`, không DELETE). Ghi qua `upload` như bảng app (sổ `app_tables` có dòng `app_id = '_core'`; `_core` là dòng `apps` ảo, không có version, không hiện ở catalog/`registry list`). Sync rules có bucket `core` theo `tenant_id` của JWT cho mọi tenant (không theo app đã cài).
- **Bucket Storage `files`** (private, 50 MB/file): đường dẫn `<tenant_id>/<file_id>`; policy `storage.objects` cho `authenticated` đọc/ghi/cập nhật khi thư mục đầu = claim `tenant_id`; không có policy xoá. Shell upload bằng supabase-js với JWT phiên và tải bằng URL ký 15 phút; metadata ở `core_files` (`uploaded_at` null = chưa lên server).
- **Thứ tự launcher**: cột `installations.position` ghi qua RPC `reorder_apps(app_ids text[])` (tenant từ JWT, chỉ installation của mình, app lạ bị bỏ qua, position = chỉ số mảng); `catalog` trả `position` mỗi app; bucket `installations` sync cả cột này (có `app_id as id`).
- **Entitlement**: `tenants.entitlement_until` (null = không hết hạn) chỉ đổi bằng CLI `set-entitlement`. `catalog` trả `server_time` và `entitlement { plan, max_apps, until, grace_days }`; `upload` trả **HTTP 403 `{ error: "READ_ONLY" }` cho cả lô** (không ghi, không `sync_rejections`) khi `until + grace_days < now()`. `grace_days` = env `ENTITLEMENT_GRACE_DAYS` (mặc định 7), cùng một giá trị cho `catalog` và `upload` — đặt biến này cho Edge Functions khi deploy; sửa xong phải `docker restart supabase_edge_runtime_platform-backend`.
