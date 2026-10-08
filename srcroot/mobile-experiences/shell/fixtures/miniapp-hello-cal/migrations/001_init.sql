-- Hello Lịch 0.1.0 — table_prefix mặc định: app_vn_app_hello_cal (id đổi "." và "-" thành "_").
-- Cột hệ thống do shell / CLI registry tự thêm. `at` là epoch ms (integer), `file_id` trỏ core_files (ảnh đính kèm).
CREATE TABLE IF NOT EXISTS app_vn_app_hello_cal_reminders (
  id text PRIMARY KEY,
  title text NOT NULL,
  at integer,
  file_id text
);
