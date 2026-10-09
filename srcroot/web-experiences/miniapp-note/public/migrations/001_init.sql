-- Ghi chú (vn.app.note) 0.1.0 — table_prefix mặc định: app_vn_app_note (id đổi "." thành "_").
-- Kiểu cột chọn cho chạy được trên cả Postgres lẫn SQLite; cột hệ thống (tenant_id, created_at, updated_at, deleted_at) do shell / CLI tự thêm.
-- Nội dung ghi chú KHÔNG nằm ở cột phẳng: chỉ ở note_blocks (Yjs, base64). `search_text` / `snippet` là bản trích dựng lại được từ Yjs.
-- `trashed_at_ms` là epoch ms (bigint — bài học `at integer` tràn của hello-cal); null = chưa ở thùng rác.
CREATE TABLE IF NOT EXISTS app_vn_app_note_notes (
  id text PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  pinned integer NOT NULL DEFAULT 0,
  trashed_at_ms bigint,
  search_text text NOT NULL DEFAULT '',
  snippet text NOT NULL DEFAULT ''
);

-- Một dòng = một update hoặc snapshot Yjs (base64). Chỉ chèn; xoá mềm khi gộp.
CREATE TABLE IF NOT EXISTS app_vn_app_note_note_blocks (
  id text PRIMARY KEY,
  note_id text NOT NULL,
  kind text NOT NULL DEFAULT 'update',
  data text NOT NULL,
  size integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS app_vn_app_note_note_blocks_note ON app_vn_app_note_note_blocks (note_id);

CREATE TABLE IF NOT EXISTS app_vn_app_note_note_tags (
  id text PRIMARY KEY,
  note_id text NOT NULL,
  tag_id text NOT NULL
);
CREATE INDEX IF NOT EXISTS app_vn_app_note_note_tags_note ON app_vn_app_note_note_tags (note_id);

CREATE TABLE IF NOT EXISTS app_vn_app_note_note_files (
  id text PRIMARY KEY,
  note_id text NOT NULL,
  file_id text NOT NULL,
  kind text NOT NULL DEFAULT 'image',
  name text,
  mime text,
  size integer
);
CREATE INDEX IF NOT EXISTS app_vn_app_note_note_files_note ON app_vn_app_note_note_files (note_id);
