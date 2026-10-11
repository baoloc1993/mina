-- Hello 0.2.0 — kiểu dữ liệu chọn sao cho chạy được trên cả Postgres lẫn SQLite.
-- Bảng app_hello_items đã có trên server từ vòng 1 (id uuid, title text, done boolean + cột hệ thống) nên
-- CREATE TABLE IF NOT EXISTS là no-op ở đó; trên SQLite của máy thì tạo mới. Cột hệ thống (tenant_id, created_at,
-- updated_at, deleted_at) do shell / CLI registry tự thêm — không khai ở đây.
CREATE TABLE IF NOT EXISTS app_hello_items (
  id text PRIMARY KEY,
  title text NOT NULL,
  done integer NOT NULL DEFAULT 0
);

-- Nháp ô nhập (AC-14): một dòng id = 'main', ghi khi app nhận sự kiện suspend.
CREATE TABLE IF NOT EXISTS app_hello_drafts (
  id text PRIMARY KEY,
  value text
);
