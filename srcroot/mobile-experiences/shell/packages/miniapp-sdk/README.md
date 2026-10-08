# @platform/miniapp-sdk 0.1.0

SDK v0 cho mini app của nền tảng Mina: `window.miniapp` (shell tiêm vào WebView), design tokens, kiểu TypeScript và
**mock chạy trên trình duyệt** để dev mini app (P4) thử mà không cần máy Android.

Contract chuẩn: `context/ARCHITECTURE.md §5` (`miniapp-sdk-v0`, `miniapp-manifest`, `sdk-tokens`, `intent-*`).
Semver từ đây: thêm method = minor, đổi/bỏ = major.

## 1. Cấu trúc gói mini app

```
vn.app.hello/
  manifest.json         khai báo (bên dưới)
  index.html            entry — HTML/JS thuần hoặc bản build; KHÔNG tải script từ ngoài
  icon.png              256×256
  tokens.css            bản sao @platform/miniapp-sdk/tokens/tokens.css (CSP chỉ cho style từ chính gói)
  migrations/
    001_init.sql        SQLite, chạy ở máy; CLI `registry` lint lại rồi áp lên Postgres
```

`manifest.json`:

```json
{
  "id": "vn.app.hello", "name": "Hello", "version": "0.2.0", "sdk": "^0.1",
  "entry": "index.html", "icon": "icon.png", "description": "…",
  "scopes": ["db.own", "core.tags:write", "intent.send", "net", "ui.native"],
  "tables": ["items", "drafts"],
  "intents": { "sends": [{ "type": "cal.reminder.create", "version": "1" }], "receives": [] },
  "network": ["vnexpress.net"],
  "offline": true
}
```

- `id`: reverse-domain. `version`: semver, mỗi lần phát hành phải **lớn hơn** bản trước.
- `tables`: tên **ngắn**. Trong JS bạn viết `SELECT … FROM items`; shell đổi thành `<table_prefix>_items`.
- `intents.receives[].schema`: JSON Schema draft-07 của payload; shell/mock kiểm bằng `ajv` trước khi giao.
- `network`: host **đúng** (không subdomain, không wildcard).
- Thiếu `id/name/version/sdk/entry` hoặc scope lạ → `BAD_MANIFEST`.

### Migration

- Đặt tên `NNN_<tên>.sql`, chỉ **cộng thêm**: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` (nullable hoặc có
  `DEFAULT` hằng), `CREATE INDEX`. Không `DROP`, không đổi kiểu cột, không đổi file đã phát hành.
- Dùng **tên bảng đầy đủ có tiền tố**: `app_<table_prefix>_<tên ngắn>`. Mặc định `table_prefix` = `app_` + id đổi `.` và `-`
  thành `_` (vd `vn.app.hello-cal` → `app_vn_app_hello_cal_reminders`).
- Kiểu **portable** cho cả Postgres và SQLite: `text`, `integer`, `real`, `boolean` ở dạng `integer`/`boolean`. Tránh
  `now()`, `uuid`, `timestamptz`, `serial`, `jsonb` (SQLite không hiểu / hiểu khác).
- **Đừng khai** `tenant_id`, `created_at`, `updated_at`, `deleted_at`: shell/CLI tự thêm cột, RLS, trigger.
- `id` do app tự sinh bằng `crypto.randomUUID()` (kiểu `text primary key`).

## 2. API `window.miniapp` (đóng băng, chỉ đọc)

| Namespace | Method | Scope cần |
|---|---|---|
| `sdk` | `ready()`, `info()`, `on(event, fn)` → hàm huỷ | luôn được |
| `db` | `query(sql, params?, {includeDeleted?})`, `execute(sql, params?)`, `transaction([{sql, params?}])` | `db.own` |
| `core.tags` | `list()`, `create({name, color?})` | `core.tags:read` / `:write` |
| `core.contacts` | `search(q)`, `create({name, phone?, email?, note?})` | `core.contacts:read` / `:write` |
| `core.files` | `get(id)`, `list({appId?})` | `core.files:read` |
| `intent` | `send(type, payload, {mode?, version?})` | `intent.send` + khai `intents.sends` |
| `notify` | `schedule({id, at, title, body?, ref?})`, `cancel(id)`, `list()` | `notify.local` |
| `storage` | `put({name, mime, base64})`, `get(fileId)`, `remove(fileId)` | `storage.files` |
| `net` | `fetch(url, {method?, headers?, body?, timeoutMs?})` | `net` + `network[]` |
| `ui` | `toast(text)`, `pickImage({multiple?})`, `share({title?, text?, url?})` | `ui.native` (`pickImage` thêm `storage.files`) |
| `sync` | `status()` | luôn được |
| `auth` | `getAppToken()` | `auth.token` |
| — | `call(method, params)` | method nào thì scope đó; method lạ → `SCOPE_DENIED` |

`:write` bao gồm `:read`. Scope `db` (vòng 1) là bí danh của `db.own`.

Sự kiện (`miniapp.sdk.on`): `suspend` · `resume` · `intent` · `sync`.

- `suspend`: shell sắp huỷ WebView của bạn. Mỗi handler có tối đa **450 ms** (trả Promise nếu bất đồng bộ) để lưu trạng thái
  (vd ghi nháp vào DB). Xong SDK tự báo shell. Lần mở lại, app nạp mới và tự khôi phục từ DB.
- `intent`: `{type, version, payload}`. Intent tới trước khi bạn đăng ký handler được giữ lại (tối đa 20) và giao khi đăng ký.
- `sync`: `{state, pending, rejected, lastSyncedAt}`.

### Quy ước đọc/ghi

- `SELECT` **tự lọc** `deleted_at IS NULL`; muốn thấy dòng đã xoá: `query(sql, params, {includeDeleted: true})`.
- `DELETE` luôn là **xoá mềm** (`UPDATE … SET deleted_at`). Xoá thắng sửa đồng thời; không có cách hồi sinh qua SDK.
- `INSERT`/`UPDATE` mà bạn truyền vào `tenant_id`, `created_at`, `updated_at`: bị bỏ qua, bridge ghi đè.
- Chỉ một câu SQL đơn giản vào bảng đã khai. `ATTACH`, `PRAGMA`, `DROP`, `CREATE`, `UNION`, `WITH`, `RETURNING`… → `SQL_REJECTED`.
- `transaction`: tối đa 100 câu, một câu hỏng thì không câu nào chạy; không nhận `SELECT`.
- Khi tài khoản **chỉ đọc** (hết ân hạn): mọi method ghi trả `READ_ONLY` (`db.execute/transaction`, `storage.put/remove`,
  `core.*.create`, `ui.pickImage`, `intent.send` mode `create`); đọc vẫn được. Dùng `sdk.info().readOnly` để hiện banner.

## 3. Mã lỗi

Mọi Promise bị từ chối bằng `Error` có `.code` (và `.detail` nếu có).

| Mã | Khi nào |
|---|---|
| `INVALID_REQUEST` | tham số sai kiểu/quá giới hạn |
| `SCOPE_DENIED` | manifest không khai scope (hoặc không khai intent trong `sends`); method không có trong SDK |
| `SQL_REJECTED` | SQL ngoài phạm vi / không hiểu được |
| `READ_ONLY` | method ghi khi chỉ đọc |
| `OFFLINE` | cần mạng nhưng đang offline (vd `net.fetch`) |
| `NOT_FOUND` | file/bản ghi không có |
| `INTENT_REJECTED` | payload sai schema (`.detail` = đường dẫn), > 64 KB, hoặc gửi cho chính mình |
| `INTENT_NO_HANDLER` | không app nào nhận type đó |
| `NET_BLOCKED` | host (hoặc đích chuyển hướng) không có trong `network[]` — request không được gửi |
| `NET_ERROR` | lỗi mạng, phản hồi > 5 MB, quá 5 lần chuyển hướng |
| `PERMISSION_DENIED` | người dùng từ chối quyền thông báo/ảnh |
| `APP_SUSPENDED` | gọi khi app đã bị tạm dừng |
| `INTERNAL` | lỗi nội bộ (vd chưa đăng nhập) |

## 4. Design tokens

Một design system cho cả shell lẫn mini app (`context/DESIGN-SYSTEM.md §2`). **Đừng tự định nghĩa màu.**

```html
<link rel="stylesheet" href="tokens.css"><!-- bản sao của tokens/tokens.css, nằm trong gói -->
<style> button { min-height: var(--tap-min); background: var(--color-primary); color: var(--color-on-primary); } </style>
```

- `tokens/tokens.json` là nguồn; `npm run build:tokens` (ở thư mục shell) sinh `tokens.css` (biến `--color-…`, `--text-…`,
  `--space-…`, `--radius-…`, `--shadow`, `--tap-min`, `--icon-app`), `tailwind.preset.js` và `tokens.ts`.
- Tailwind: `presets: [require('@platform/miniapp-sdk/tokens/tailwind.preset.js')]`.
- Quy tắc: chữ ≥ `--text-base` (17px), vùng chạm ≥ `--tap-min` (48px), chỉ giao diện sáng, 15 cặp tương phản AA đã có test.

## 5. Chạy mock trên trình duyệt

```bash
cd srcroot/mobile-experiences/shell
npm run mock -- fixtures/miniapp-hello          # mở http://localhost:5199
```

- Mini app chạy trong `<iframe sandbox="allow-scripts">` với **đúng CSP và SDK thật** của shell; mọi lời gọi đi qua **chính
  `handleRpc` của shell** (`src/bridge`) với Host trình duyệt: SQLite WASM (lưu ở IndexedDB, một DB chung cho mọi app như
  shell), `net.fetch` qua dev server (kiểm whitelist ở từng bước chuyển hướng), thông báo giả, toast, chọn ảnh, chia sẻ.
- Bên phải là console: giờ · method · scope cần · kết quả/mã lỗi. Lời gọi lặp y hệt được gộp thành `×N`.
- Thanh trên: đổi fixture, **mạng** (online / offline / chỉ đọc), **Chạy ma trận scope** (so với `matrix.expected.ts`),
  tick/bỏ tick scope của manifest để thấy `SCOPE_DENIED`, **Đặt lại DB**. Nút Suspend / Resume / Tải lại app mô phỏng vòng đời WebView.
- **Intent giữa hai app:** mở thêm tab `http://localhost:5199/?fixture=miniapp-hello-cal`; tab nào đang mở thì nhận intent
  (qua `BroadcastChannel`). Không có tab nhận → `INTENT_NO_HANDLER`.
- Tiền tố bảng được suy ra từ migration; ghi đè bằng `?prefix=app_xxx`.
- Giới hạn: không có sync thật (công tắc "mạng" chỉ giả trạng thái); OPFS chưa dùng (DB trong bộ nhớ + ảnh chụp IndexedDB);
  hai tab ghi cùng lúc trong 300 ms có thể mất một thay đổi.

## 6. Viết test cho mini app

- Test logic thuần bằng Vitest/Jest như bình thường; với `window.miniapp` thì giả bằng `INJECTED_SDK`:

  ```ts
  import { INJECTED_SDK } from '@platform/miniapp-sdk/src/injected';
  window.__miniappTransport = (json) => { /* trả lời bằng window.__miniappResolve({jsonrpc:'2.0', id, result}) */ };
  new Function(INJECTED_SDK)();
  ```
- Test chạy trọn bridge: dùng `handleRpc` của shell với Host giả (xem `packages/miniapp-sdk/test/host.test.ts`, dùng
  `node:sqlite`).
- Ca phá nên có: bảng không khai, SQL hỏng, `ATTACH`/`PRAGMA`/`DROP`, gọi method thiếu scope, domain lạ, payload intent sai.

## 7. Fixture mẫu

`fixtures/miniapp-hello` (0.2.0) · `fixtures/miniapp-hello-cal` (0.1.0) · `npm run build:fixtures` đóng gói tất cả vào
`fixtures/dist/<id>-<version>.zip` (tái lập) · `node fixtures/make-clone.mjs <nguồn> <id-mới> <tên-mới> <đích>` nhân bản thành app khác.
