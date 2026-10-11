-- Đọc báo (vn.app.news) 0.1.0 — table_prefix mặc định: app_vn_app_news (id đổi "." thành "_").
-- Kiểu cột chạy được trên cả Postgres lẫn SQLite; cột hệ thống (tenant_id, created_at, updated_at, deleted_at) do shell / CLI tự thêm.
-- KHÔNG lưu toàn văn bài: `items` chỉ có tiêu đề + tóm tắt (đã bỏ thẻ HTML) + liên kết.
-- `items.id` là UUID TẤT ĐỊNH từ feed_url|guid (hai máy tải cùng bài ra cùng dòng). Mọi cột epoch là bigint.
CREATE TABLE IF NOT EXISTS app_vn_app_news_sources (
  id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  feed_url text NOT NULL,
  host text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  suggested_key text,
  last_fetched_at_ms bigint,
  last_error text
);

CREATE TABLE IF NOT EXISTS app_vn_app_news_items (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  guid text NOT NULL,
  title text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  link text NOT NULL,
  image_url text,
  published_at_ms bigint,
  fetched_at_ms bigint NOT NULL DEFAULT 0,
  read_at_ms bigint,
  saved_at_ms bigint,
  note_id text
);
CREATE INDEX IF NOT EXISTS app_vn_app_news_items_source ON app_vn_app_news_items (source_id);
CREATE INDEX IF NOT EXISTS app_vn_app_news_items_published ON app_vn_app_news_items (published_at_ms);
