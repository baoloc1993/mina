-- Lịch (vn.app.calendar) 0.1.0 — table_prefix mặc định: app_vn_app_calendar (id đổi "." thành "_").
-- Kiểu cột chạy được trên cả Postgres lẫn SQLite; cột hệ thống (tenant_id, created_at, updated_at, deleted_at) do shell / CLI tự thêm.
-- Không lưu từng lần lặp: `events` giữ QUY TẮC, `event_overrides` giữ ngoại lệ "chỉ lần này".
-- Mọi cột epoch là bigint (bài học `at integer` tràn int4 của hello-cal).
CREATE TABLE IF NOT EXISTS app_vn_app_calendar_events (
  id text PRIMARY KEY,
  kind text NOT NULL DEFAULT 'event',
  title text NOT NULL DEFAULT '',
  all_day integer NOT NULL DEFAULT 0,
  start_local text NOT NULL,
  end_local text,
  fixed integer NOT NULL DEFAULT 0,
  start_ms bigint,
  end_ms bigint,
  tz text,
  repeat_unit text,
  repeat_every integer NOT NULL DEFAULT 1,
  repeat_cal text NOT NULL DEFAULT 'solar',
  repeat_until text,
  lunar_month integer,
  lunar_day integer,
  alert_min integer NOT NULL DEFAULT 0,
  done_at_ms bigint,
  src_app text,
  src_id text
);
CREATE INDEX IF NOT EXISTS app_vn_app_calendar_events_start ON app_vn_app_calendar_events (start_local);

CREATE TABLE IF NOT EXISTS app_vn_app_calendar_event_overrides (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  occ_date text NOT NULL,
  action text NOT NULL,
  patch text NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS app_vn_app_calendar_event_overrides_event ON app_vn_app_calendar_event_overrides (event_id);
