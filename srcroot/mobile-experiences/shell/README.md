# shell — vỏ ứng dụng (Expo, Android ở vòng 1)

Vòng 1 là spike: shell đăng nhập bằng email OTP, giữ dữ liệu trong SQLite mã hoá (SQLCipher), đồng bộ
bằng PowerSync, và mở mini app trong WebView. App thử là `fixtures/miniapp-hello`.

**Phạm vi vòng 1:** shell chỉ có MỘT mini app là Hello, đi kèm shell dưới dạng asset và tự cài lần đầu chạy.
Chưa có cách cài gói thứ hai: registry, ký gói, catalog và màn cài app là việc của vòng 2–3.
Muốn thử mini app của bạn ở vòng này, thay nội dung `fixtures/miniapp-hello/` (xem "Mini app" bên dưới).

## Chạy

Từ gốc repo, cần Docker đang chạy:

```bash
make doctor   # kiểm môi trường, in cái gì thiếu
make dev      # Supabase + PowerSync (docker) + Metro
```

Cài bản dev lên emulator Android một lần (cần JDK 21 và Android SDK):

```bash
cd srcroot/mobile-experiences/shell
npx expo run:android
```

Đăng nhập: nhập email, bấm "Gửi mã". Mã 6 số nằm ở hộp thư thử Mailpit: mở http://127.0.0.1:54324,
hoặc lấy bằng lệnh `curl http://127.0.0.1:54324/api/v1/messages` (lấy `ID` mới nhất) rồi
`curl http://127.0.0.1:54324/api/v1/message/<ID>` (trường `Text`).

Dữ liệu mẫu (cần Python 3, chỉ dùng thư viện chuẩn): `python deployment/local/seed/seed.py` tạo user
`a@test.local`, `b@test.local` (mỗi người một tenant) và 20 mục mỗi tenant; `--clean` xoá sạch.

Màn chính cho biết: `Trạng thái` (offline / đang sync / đã sync / lỗi), `tenant` (8 ký tự đầu id tenant của bạn),
`mục local` (số mục Hello đang có trên máy, không tính mục đã xoá), và số lần mở / trung vị thời gian mở mini app.
Lưu ý: **đăng xuất xoá dữ liệu local** — nếu còn thay đổi chưa gửi lên máy chủ, shell sẽ hỏi lại trước khi xoá.

## Mini app

Một mini app là một thư mục có `manifest.json` + `index.html`, đóng thành zip.

```json
{ "id": "vn.app.hello", "name": "Hello", "version": "0.0.1", "sdk": "0", "entry": "index.html",
  "scopes": ["db", "auth.token"], "tables": ["items"] }
```

| Trường | Ý nghĩa |
|---|---|
| `id` | reverse-domain, không bao giờ đổi. Đoạn cuối quyết định tên bảng thật (xem dưới) |
| `sdk` | phiên bản hợp đồng SDK; vòng 1 luôn là `"0"` |
| `entry` | file HTML mở đầu tiên |
| `scopes` | quyền app được dùng. `db` = `db.query`/`db.execute`; `auth.token` = `auth.getAppToken`. Gọi method không có scope → `SCOPE_DENIED` |
| `tables` | tên NGẮN của các bảng app được đọc/ghi |

Đóng gói (chạy từ thư mục `shell/`, không phải gốc repo):

```bash
cd srcroot/mobile-experiences/shell
node fixtures/miniapp-hello/build.js   # → assets/miniapp-hello.zip
```

`build.js` đang đóng cứng đúng hai file của hello; muốn đóng app khác, sao chép nó và đổi đường dẫn.

### Dữ liệu: bảng, cột, ai điền gì

- Bảng thật ở máy và server tên `app_<đoạn cuối của id>_<tên ngắn>`: app khai `items`, id `vn.app.hello` → `app_hello_items`.
  App luôn viết tên ngắn trong SQL; bridge tự đổi tên.
- **Bảng do migration phía server tạo** (`srcroot/boundaries/platform-backend/supabase/migrations/`), không phải mini app tự tạo.
  Mini app không có quyền `CREATE`.
- Mọi bảng đồng bộ có: `id` (UUID, app tự sinh bằng `crypto.randomUUID()`, bắt buộc có trong `INSERT`), `tenant_id`,
  `created_at`, `updated_at`, `deleted_at`. App KHÔNG điền bốn cột sau: bridge ghi đè `tenant_id`, `created_at`,
  `updated_at` theo phiên đăng nhập; giá trị app truyền vào các cột đó bị bỏ qua.
- **Xoá là xoá mềm**: `DELETE FROM items WHERE …` được bridge viết lại thành đặt `deleted_at`. Bản ghi vẫn còn,
  nên `SELECT` phải tự thêm `WHERE deleted_at IS NULL` (Hello làm vậy).

### SDK `window.miniapp` (v0)

Mọi hàm trả Promise. Lỗi có `e.code` và `e.message`.

| Hàm | Tham số → kết quả |
|---|---|
| `sdk.ready()` | gọi MỘT lần khi giao diện đã sẵn sàng; shell tắt màn chờ và ghi thời gian mở |
| `db.query(sql, params)` | `SELECT` → mảng hàng (`[{col: giá trị}]`) |
| `db.execute(sql, params)` | `INSERT` / `UPDATE` / `DELETE` → `true` |
| `auth.getAppToken()` | → `{ token, expires_at }` JWT 15 phút theo app; offline thì trả bản cache còn hạn, hết hạn → lỗi `OFFLINE` |

SQL được phép: đúng MỘT câu `SELECT` / `INSERT` / `UPDATE` / `DELETE` đơn giản vào bảng đã khai ở `tables`; `INSERT`
phải liệt kê cột và có `VALUES (…)`. Bị từ chối (`SQL_REJECTED`): nhiều câu, comment, `JOIN`, subquery, `UNION`,
`ATTACH`, `PRAGMA`, `DROP`, `CREATE`, bảng không khai. Mini app KHÔNG được dùng `fetch`, `XMLHttpRequest`,
`WebSocket`, `localStorage`: shell chặn mạng trực tiếp bằng CSP (trình duyệt báo `TypeError: Failed to fetch`).
Mã lỗi: `SCOPE_DENIED`, `SQL_REJECTED`, `OFFLINE`, `INTERNAL`.

## Kiểm

```bash
make check   # typecheck + đóng gói hello
make test    # pgTAP (RLS) + Jest (SQL guard, bridge, SDK, thông báo đăng nhập)
```
