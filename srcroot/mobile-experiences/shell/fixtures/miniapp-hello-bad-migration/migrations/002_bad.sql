-- CỐ Ý LỖI trên SQLite (fixture test rollback gói, AC-3); Postgres áp được và lint server cho qua (cộng thêm, có DEFAULT).
-- 1) SQLite không cho thêm cột DEFAULT không hằng khi bảng ĐÃ CÓ DÒNG: "Cannot add a column with non-constant default".
ALTER TABLE app_hello_items ADD COLUMN stamp text DEFAULT CURRENT_TIMESTAMP;
-- 2) `DEFAULT now()` là cú pháp Postgres; SQLite luôn báo lỗi cú pháp (kể cả bảng rỗng) — bảo đảm lỗi.
ALTER TABLE app_hello_items ADD COLUMN stamped_at timestamptz DEFAULT now();
