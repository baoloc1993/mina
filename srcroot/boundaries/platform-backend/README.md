# platform-backend — backend nền tảng mini app

Supabase (Postgres + RLS, Auth, Storage, Edge Functions) + PowerSync. Contract đầy đủ: [`context/ARCHITECTURE.md §5–§6`](../../../context/ARCHITECTURE.md).

## Chạy local

```bash
make dev                                   # từ gốc repo: Supabase + PowerSync + khoá ký thử
python deployment/local/seed/seed.py       # 2 tenant (a@test.local, b@test.local) + app hello + app riêng của a
make test                                  # pgTAP + deno + node + Jest
make accept                                # acceptance HTTP AC-1..AC-10 trên backend đang chạy
```

Sửa Edge Function xong phải `docker restart supabase_edge_runtime_platform-backend` (runtime không tự nạp lại).

## Phát hành mini app (dành cho dev — persona P4)

Mọi thao tác đi qua CLI `registry`, chạy **từ thư mục này**, trên máy có service key (không bao giờ trong shell/app):

```bash
cd srcroot/boundaries/platform-backend
npm run registry                           # xem mọi lệnh
```

1. **Khoá ký** — `make dev` đã sinh `deployment/local/keys/signing-local-1.pem` (gitignore). `keygen` chỉ cần chạy khi chưa có và **không ghi đè** khoá sẵn có.
2. **Chuẩn bị thư mục app** — `manifest.json` và file `entry` **cạnh nhau**; migration (nếu có) ở `migrations/*.sql`. Nếu app có bước build, publish thư mục đã build.

   ```json
   { "id": "vn.app.note", "name": "Ghi chú", "version": "0.1.0", "sdk": "0",
     "entry": "index.html", "scopes": ["db"], "tables": ["notes"] }
   ```

   - `id`: reverse-domain chữ thường; không bao giờ đổi. `version`: semver `x.y.z`, **mỗi lần publish phải lớn hơn** bản đã có.
   - `tables`: tên ngắn; bảng thật là `<table_prefix>_<tên>` (mặc định `app_` + id đổi `.`/`-` thành `_`, vd `app_vn_app_note_notes`).
   - Migration chỉ được **cộng thêm** trên bảng của app: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` (nullable hoặc có DEFAULT), `CREATE INDEX`. Chỉ khai `CREATE TABLE` — CLI tự thêm `tenant_id`, `created_at`, `updated_at`, `deleted_at`, RLS, trigger giờ server và đưa bảng vào sync. Đã áp rồi thì không sửa file cũ — thêm file mới.
3. **Publish → thử → công bố**

   ```bash
   npm run registry -- publish ./my-app                      # → bản draft (thêm --owner <email> nếu là app riêng của một tenant)
   npm run registry -- add-tester vn.app.note 0.1.0 a@test.local   # tenant này thấy bản draft
   npm run registry -- list                                  # kiểm trạng thái
   npm run registry -- promote vn.app.note 0.1.0             # công bố cho mọi tenant
   npm run registry -- gen-sync-rules                        # có bảng mới? báo có đổi không + lệnh restart PowerSync
   npm run registry -- revoke vn.app.note 0.1.0              # bản lỗi: thu hồi (không quay lại được)
   ```

4. **Kiểm catalog** — `GET /functions/v1/catalog` với JWT của tenant (xem `scripts/acceptance.ts`, hàm `extraSession`, để lấy JWT thử cho `a@test.local` bằng admin `generate_link`).

Gói hello (fixture của shell) có `entry` trong `src/` nên **không publish thẳng được** — `seed.py` dựng thư mục tạm; app mới đặt `entry` cạnh `manifest.json`.

## Mã lỗi

Edge Functions: `{ "error": "<CODE>", "detail"?: "…" }` với HTTP status đúng nghĩa. RPC Postgres (`install_app`, `revoke_device`…): PostgREST luôn trả **HTTP 400** với `{ "message": "<CODE>" }` — chỉ tin `message`, không tin status. Danh sách mã: `ARCHITECTURE.md §5`.
