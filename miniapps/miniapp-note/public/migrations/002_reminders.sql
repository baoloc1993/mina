-- Ghi chú (vn.app.note) 0.2.0 — CỘNG THÊM (không sửa 001): bản ghi nhớ phía Ghi chú cho lời nhắc đã gửi sang Lịch.
-- `id` = eventId đã gửi cho Lịch (calendar.reminder.create); `at_local` = 'YYYY-MM-DDTHH:mm' (giờ treo, không múi giờ).
-- Nguồn sự thật của lời nhắc là bảng events của Lịch; đây chỉ để hiện dòng "Lời nhắc: …" và mở lại.
CREATE TABLE IF NOT EXISTS app_vn_app_note_note_reminders (
  id text PRIMARY KEY,
  note_id text NOT NULL,
  at_local text NOT NULL,
  title text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS app_vn_app_note_note_reminders_note ON app_vn_app_note_note_reminders (note_id);
