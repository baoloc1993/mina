# Mina — lệnh build / test / run
#
# Sáu lệnh dưới đây là giao diện chung của MỌI stack. Quy trình dự án
# chỉ gọi các lệnh này, không cần biết bên dưới là gì.
# 
#
# Đường intake, đa target: thân lệnh điều phối xuống srcroot/<nhóm>/<tên>.
# Artifact để CHẠY nằm ở deployment/ (deployment/README.md). Giá trị biến môi trường nằm ở
# deployment/local/.env (không commit) — make nạp vào môi trường, không in ra.

.PHONY: help dev check test accept migrate deploy doctor gate mock seed release-android release-android-local keystore-local keystore-prod

PYTHON ?= python
export PYTHONUTF8 = 1

BACKEND := srcroot/boundaries/platform-backend
SHELL_DIR := srcroot/mobile-experiences/shell
COMPOSE := docker compose --env-file deployment/local/.env -f deployment/local/docker-compose.yml
# Nhẹ RAM: bỏ các service Supabase chưa cần (giữ db, auth, rest, kong, edge-runtime, mailpit, storage-api cho bucket `packages`).
SB_EXCLUDE := studio,realtime,imgproxy,vector,logflare,postgres-meta,pgadmin-schema-diff,migra,supavisor
SUPABASE := cd $(BACKEND) && npx --yes supabase@latest
NOTE_DIR := srcroot/web-experiences/miniapp-note
CAL_DIR := srcroot/web-experiences/miniapp-calendar
NEWS_DIR := srcroot/web-experiences/miniapp-news
NPM_BE := cd $(BACKEND) && npm --silent

-include deployment/local/.env
# Google/Apple bật phía server bằng env (vòng 2); chưa có khoá thật thì dùng giá trị giả để local vẫn khởi động.
GOOGLE_OAUTH_CLIENT_ID ?= local-no-google
GOOGLE_OAUTH_CLIENT_SECRET ?= local-no-google
APPLE_CLIENT_ID ?= local.no.apple
APPLE_CLIENT_SECRET ?= local-no-apple
export

help:
	@echo "Mina — (vòng 6: Đọc báo + net.requestAccess / ui.openUrl)"
	@echo ""
	@echo "  make dev      Supabase (+ Storage) + PowerSync (docker) + khoá ký thử + Metro cho dev build Android"
	@echo "  make check    tokens + typecheck shell + SDK/mock + đóng gói fixtures + CLI registry + Edge Functions"
	@echo "  make test     pgTAP + deno test + node test (CLI) + Jest (shell: bridge, package manager, entitlement…) + Vitest (SDK + mock)"
	@echo "  make mock     mock SDK trên trình duyệt: make mock FIXTURE=fixtures/miniapp-hello"
	@echo "  make seed     dữ liệu mẫu + publish hello 0.2.0, hello-cal, bản hello 0.3.0 lỗi migration (cần make dev)"
	@echo "  make accept   acceptance HTTP trên backend local đang chạy (sau make dev + seed), gồm accept:ops (vòng 7)"
	@echo "  make release-android[-local]  APK release ký thật (prod: https + keystore prod · local: backend docker)"
	@echo "  make migrate  áp migration có version vào DB local"
	@echo "  make deploy   lên production: Supabase Cloud + Edge Functions + registry + APK (deployment/prod/README.md; --dry-run để xem trước)"
	@echo ""
	@echo ""

dev:
	@test -f deployment/local/.env || (echo "Thiếu deployment/local/.env — copy từ deployment/.env.example rồi điền" && exit 1)
	$(NPM_BE) install --no-audit --no-fund
	$(SUPABASE) start -x $(SB_EXCLUDE)
	$(COMPOSE) up -d
	$(NPM_BE) run registry -- keygen
	@echo ""
	@echo "Backend lên: API http://127.0.0.1:54321 · PowerSync http://127.0.0.1:8090 · mail OTP http://127.0.0.1:54324"
	@echo "Dữ liệu mẫu + registry (hello, app riêng): python deployment/local/seed/seed.py   ·   sau khi sửa Edge Function: docker restart supabase_edge_runtime_platform-backend"
	@echo "Shell: build dev bản Android một lần: (cd $(SHELL_DIR) && npx expo run:android), sau đó Metro:"
	cd $(SHELL_DIR) && EXPO_PUBLIC_SUPABASE_URL=$(SUPABASE_URL) EXPO_PUBLIC_SUPABASE_ANON_KEY=$(SUPABASE_ANON_KEY) EXPO_PUBLIC_POWERSYNC_URL=$(POWERSYNC_URL) EXPO_PUBLIC_OAUTH_PROVIDERS=google,apple npx expo start --dev-client

check:
	cd $(SHELL_DIR) && npm --silent run build:tokens && npm --silent run build:fixtures
	cd $(SHELL_DIR) && npx tsc --noEmit && npx tsc --noEmit -p packages/miniapp-sdk
	$(NPM_BE) run typecheck
	cd $(NOTE_DIR) && npm --silent run typecheck && npm --silent run build
	cd $(CAL_DIR) && npm --silent run typecheck && npm --silent run build
	cd $(NEWS_DIR) && npm --silent run typecheck && npm --silent run build
	$(NPM_BE) exec -- deno check --no-lock supabase/functions/upload/index.ts supabase/functions/catalog/index.ts supabase/functions/issue-app-token/index.ts supabase/functions/health/index.ts
	@echo "OK: typecheck shell + SDK/mock + Ghi chú + Lịch + Đọc báo (build dist/) + CLI registry + Edge Functions sạch, fixtures đóng được"

test:
	$(SUPABASE) test db
	$(NPM_BE) run test:functions
	$(NPM_BE) run test:cli
	cd $(SHELL_DIR) && npx jest
	cd $(SHELL_DIR) && npm --silent run test:sdk
	cd $(NOTE_DIR) && npm --silent test
	cd $(CAL_DIR) && npm --silent test
	cd $(NEWS_DIR) && npm --silent test

FIXTURE ?= fixtures/miniapp-hello
mock:
	cd $(SHELL_DIR) && npm run mock -- $(FIXTURE)

seed:
	$(PYTHON) deployment/local/seed/seed.py

accept:
	$(NPM_BE) run accept
	$(NPM_BE) run accept:notes
	$(NPM_BE) run accept:calendar
	$(NPM_BE) run accept:news
	$(NPM_BE) run accept:ops

# --- vòng 7: APK release ký thật ---
# Local: backend docker (cleartext), keystore riêng ở deployment/local/keys (ANDROID_KEYSTORE_* trong deployment/local/.env).
keystore-local:
	node $(SHELL_DIR)/scripts/new-keystore.mjs --path deployment/local/keys/mina-release-local.jks --env deployment/local/.env --cn "Mina Local"

release-android-local:
	cd $(SHELL_DIR) && EXPO_PUBLIC_SUPABASE_URL=$(SUPABASE_URL) EXPO_PUBLIC_SUPABASE_ANON_KEY=$(SUPABASE_ANON_KEY) EXPO_PUBLIC_POWERSYNC_URL=$(POWERSYNC_URL) node scripts/release-android.mjs --local

# Production: biến ở deployment/prod/.env (không commit). Gỡ ANDROID_* của local trước để không lẫn khoá.
keystore-prod:
	node $(SHELL_DIR)/scripts/new-keystore.mjs --path deployment/prod/keys/mina-release.jks --env deployment/prod/.env --cn "Mina Platform"

release-android:
	@test -f deployment/prod/.env || (echo "Thiếu deployment/prod/.env (xem deployment/prod/README.md)" && exit 1)
	unset ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; set -a; . deployment/prod/.env; set +a; cd $(SHELL_DIR) && EXPO_PUBLIC_SUPABASE_URL=$$SUPABASE_URL EXPO_PUBLIC_SUPABASE_ANON_KEY=$$SUPABASE_ANON_KEY EXPO_PUBLIC_POWERSYNC_URL=$$POWERSYNC_URL node scripts/release-android.mjs

migrate:
	$(SUPABASE) migration up --local

# Production (vòng 7): deployment/prod/deploy.py. Thêm cờ: make deploy DEPLOY_ARGS="--dry-run"
# Tạo tài khoản: make deploy DEPLOY_ARGS="create-user a@b.c"
DEPLOY_ARGS ?=
deploy:
	@$(PYTHON) deployment/prod/deploy.py $(DEPLOY_ARGS)

