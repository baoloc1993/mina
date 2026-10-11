# deployment/prod — đưa lên production (vòng 7)

> Mọi giá trị bí mật nằm ở `deployment/prod/.env` (bị `.gitignore` chặn), **không bao giờ** trong repo.

## File ở đây

| File | Là gì | Commit? |
|---|---|---|
| `deploy.py` | Thân của `make deploy`: preflight → link → db → secrets → functions → auth → registry → powersync → health → android; `create-user <email>` | có |
| `.env` | Biến production (tên ở `deployment/.env.example`, phần "vòng 7") | **không** |
| `keys/` | Khoá ký mini app `prod-1.pem`, keystore APK `mina-release.jks` | **không** (`*.pem`, `*.jks`) — **sao lưu 2 nơi** |
| `sync-rules.yaml` | Sync rules sinh từ registry **production** (`registry gen-sync-rules`), đẩy lên PowerSync Cloud | có thể commit (không bí mật) |
| `releases/` | APK đã ký (giữ 2 bản gần nhất) | không |

## Việc cần làm MỘT lần (đăng ký dịch vụ, tốn tiền — không ai làm hộ được)

1. **Supabase**: tạo project, vùng **Singapore (`ap-southeast-1`)**, gói **Pro**. Đặt mật khẩu database mạnh, cất vào kho mật khẩu.
   Lấy: *Project ref* (20 ký tự), *anon key*, *service_role key* (Dashboard → Project Settings → API), chuỗi **Session pooler** (Dashboard → Connect, cổng 5432) làm `DATABASE_URL`.
   Tạo *access token* ở `supabase.com/dashboard/account/tokens` → `SUPABASE_ACCESS_TOKEN`.
2. **PowerSync Cloud**: đăng ký, tạo instance gói **Free**, nối vào Postgres của project Supabase ở bước 1. Lấy URL instance → `POWERSYNC_URL`.
3. Tạo `deployment/prod/.env` từ phần "vòng 7" của `deployment/.env.example`. Sinh `APP_TOKEN_SECRET` (≥ 32 ký tự ngẫu nhiên):
   `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
4. Sinh khoá: `make keystore-prod` (keystore APK → ghi 4 biến `ANDROID_*` vào `.env`) và `REGISTRY_ENV=prod npm --prefix backend run registry -- keygen` (khoá ký mini app; đặt `SIGNING_KEY_PATH=deployment/prod/keys/prod-1.pem`, `SIGNING_KEY_ID=prod-1`).
   **Sao lưu `deployment/prod/keys/` + `.env` ra hai nơi ngoài máy này ngay.**

## Mỗi lần deploy

```bash
make deploy DEPLOY_ARGS="--dry-run"      # xem trước từng bước
make deploy                              # chạy thật
make deploy DEPLOY_ARGS="create-user a@b.c"   # tạo tài khoản (production tắt tự đăng ký)
```

`make deploy` dừng ở lỗi đầu tiên và chạy lại được an toàn.
