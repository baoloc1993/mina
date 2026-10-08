# Mina — lệnh build / test / run
#
# Sáu lệnh dưới đây là giao diện chung của MỌI stack. Quy trình dự án
# chỉ gọi các lệnh này, không cần biết bên dưới là gì.
# 
#
# Đường intake, đa target: thân lệnh điều phối xuống srcroot/<nhóm>/<tên>.
# Artifact để CHẠY nằm ở deployment/ (deployment/README.md). Giá trị biến môi trường nằm ở
# deployment/local/.env (không commit) — make nạp vào môi trường, không in ra.

.PHONY: help dev check test accept migrate deploy doctor gate

PYTHON ?= python
export PYTHONUTF8 = 1

BACKEND := srcroot/boundaries/platform-backend
SHELL_DIR := srcroot/mobile-experiences/shell
COMPOSE := docker compose --env-file deployment/local/.env -f deployment/local/docker-compose.yml
# Nhẹ RAM: bỏ các service Supabase chưa cần (giữ db, auth, rest, kong, edge-runtime, mailpit, storage-api cho bucket `packages`).
SB_EXCLUDE := studio,realtime,imgproxy,vector,logflare,postgres-meta,pgadmin-schema-diff,migra,supavisor
SUPABASE := cd $(BACKEND) && npx --yes supabase@latest
NPM_BE := cd $(BACKEND) && npm --silent

-include deployment/local/.env
# Google/Apple bật phía server bằng env (vòng 2); chưa có khoá thật thì dùng giá trị giả để local vẫn khởi động.
GOOGLE_OAUTH_CLIENT_ID ?= local-no-google
GOOGLE_OAUTH_CLIENT_SECRET ?= local-no-google
APPLE_CLIENT_ID ?= local.no.apple
APPLE_CLIENT_SECRET ?= local-no-apple
export

help:
	@echo "Mina — (vòng 2: nền platform-backend)"
	@echo ""
	@echo "  make dev      Supabase (+ Storage) + PowerSync (docker) + khoá ký thử + Metro cho dev build Android"
	@echo "  make check    typecheck shell + gói hello + CLI registry + Edge Functions"
	@echo "  make test     pgTAP (RLS, quota, thiết bị) + deno test (LWW) + node test (lint/ký) + Jest (shell)"
	@echo "  make accept   acceptance HTTP AC-1..AC-10 trên backend đang chạy (sau make dev + seed)"
	@echo "  make migrate  áp migration có version vào DB local"
	@echo "  make deploy   (chưa có nơi deploy — vòng 7)"
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
	cd $(SHELL_DIR) && EXPO_PUBLIC_SUPABASE_URL=$(SUPABASE_URL) EXPO_PUBLIC_SUPABASE_ANON_KEY=$(SUPABASE_ANON_KEY) EXPO_PUBLIC_POWERSYNC_URL=$(POWERSYNC_URL) npx expo start --dev-client

check:
	node $(SHELL_DIR)/fixtures/miniapp-hello/build.js
	cd $(SHELL_DIR) && npx tsc --noEmit
	$(NPM_BE) run typecheck
	$(NPM_BE) exec -- deno check --no-lock supabase/functions/upload/index.ts supabase/functions/catalog/index.ts supabase/functions/issue-app-token/index.ts
	@echo "OK: typecheck shell + CLI registry + Edge Functions sạch, gói hello đóng được"

test:
	$(SUPABASE) test db
	$(NPM_BE) run test:functions
	$(NPM_BE) run test:cli
	cd $(SHELL_DIR) && npx jest

accept:
	$(NPM_BE) run accept

migrate:
	$(SUPABASE) migration up --local

deploy:
	@echo "Chưa có nơi deploy — vòng 1–6 chỉ chạy local; deploy lần đầu ở vòng 7 (ROADMAP §1)."
	@exit 1

