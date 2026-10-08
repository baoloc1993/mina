-- Dogfood (breaker): title dài 10.000 ký tự vẫn được ghi. Giới hạn hợp lý ở DB (migration cộng thêm).
alter table public.app_hello_items
  add constraint app_hello_items_title_len check (char_length(title) <= 2000);
