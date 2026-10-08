-- Hello Lịch 0.1.1: `at integer` (int4) tràn với epoch ms (phát hiện khi chạy trên máy, vòng 3) — cộng thêm cột bigint `at_ms`.
-- Migration chỉ cộng thêm nên không đổi kiểu cột cũ; app 0.1.1 ghi/đọc `at_ms`, cột `at` bỏ không dùng.
ALTER TABLE app_vn_app_hello_cal_reminders ADD COLUMN at_ms bigint;
