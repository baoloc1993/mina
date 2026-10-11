# shell — Mina (Expo React Native, Android; iOS từ vòng 7)

Vòng 3 là **shell nền**: đăng nhập OTP, launcher + catalog, cài / cập nhật / rollback / gỡ / xoá hẳn gói **ký thật**,
WebView host + bridge với SDK v0 đủ 10 namespace, intent giữa app, dịch vụ native (thông báo, ảnh, chia sẻ, mạng có whitelist),
file lớn qua Storage, entitlement + chế độ chỉ đọc, trạng thái sync + hàng đợi lỗi, vòng đời ≤ 3 WebView, mock SDK trên trình duyệt.

```
src/bridge/      bridge JSON-RPC + scope guard + SQL guard (THUẦN TS — mock SDK dùng chung) · matrix.ts = bảng kỳ vọng chung
src/packages/    package manager: tải, SHA-256, Ed25519, sdk range, giải nén an toàn, lint manifest/migration, 2 version, rollback
src/store/       SQLite + SQLCipher, PowerSync, schema động theo app đã cài, connector (lô ≤ 100, 401 / READ_ONLY)
src/entitlement/ cache entitlement + ân hạn 7 ngày bằng đồng hồ đơn điệu (không tin giờ máy)
src/runtime/     RuntimeState cho UI: phiên, catalog, cài/gỡ, vòng đời WebView (LiveSet), intent, đồng bộ, thiết bị
src/native/      thông báo, ảnh, file cache (LRU, không dọn file chưa upload), net.fetch (whitelist + chuyển hướng thủ công)
src/webview/     MiniAppHost + LiveApps (≤ 3 WebView sống)
src/ui/ screens/ component C1–C14 + màn S1–S8 theo prototype/shell/index.html và DESIGN-SYSTEM.md
packages/miniapp-sdk/   SDK 0.1.0: tokens, mã inject, d.ts, mock SDK (Vite + SQLite WASM) — xem README trong đó
fixtures/        mini app thử (không phát hành): hello, hello-cal, hello-bad-migration + build.js (zip tái lập)
```

## Chạy

Từ gốc repo, cần Docker:

```bash
make dev             # Supabase + PowerSync + Metro (lần đầu build dev APK: cd mobile && npx expo run:android)
make seed            # 2 tenant, hello, hello-cal, private-a, bản hello draft lỗi migration, vài tag mẫu
make mock FIXTURE=fixtures/miniapp-hello   # mock SDK trên trình duyệt (S10)
make check && make test
```

Đăng nhập thử: email bất kỳ (vd `a@test.local`) → "Gửi mã" → mã 6 số ở Mailpit http://127.0.0.1:54324. Email mới = tenant mới trống.

Lưu ý khi phát triển:
- Dev build cần module native — `expo-notifications`, `expo-image-picker`, `expo-web-browser`, `expo-device`, `react-native-safe-area-context`, `expo-splash-screen` (đã khai `buildFromSource` ở `package.json` vì bản dựng sẵn thiếu trong kho). Thêm module native ⇒ build lại APK.
- Cổng Metro mặc định 8081 có thể bị container khác chiếm: chạy `npx expo start --dev-client --port 8099` và `adb reverse tcp:8099 tcp:8099`.
- `updateSchema` của PowerSync chỉ chạy khi ngắt kết nối — runtime (`applySchema`) tự ngắt → cập nhật → nối lại.
- `db.connect()` không trả về tới khi nối xong: đừng `await` ở đường khởi động.

## Mini app

Gói zip = `manifest.json` + `index.html` (+ assets) + `icon.png` + `migrations/NNN_*.sql` (tên bảng ĐẦY ĐỦ có tiền tố `table_prefix_`, kiểu portable Postgres↔SQLite, chỉ cộng thêm; **mọi `id` là UUID**). Hợp đồng đầy đủ + bảng scope ↔ method + mã lỗi: `packages/miniapp-sdk/README.md`. Phát hành: `backend/README.md`.

## Kiểm

```bash
make check   # tokens + typecheck shell/SDK + đóng gói fixtures + CLI + Edge Functions
make test    # pgTAP + deno + node + Jest (bridge, guard, package manager, entitlement, vòng đời, intent) + Vitest (SDK, mock)
```
