# Mina — lệnh build / test / run
#
# Sáu lệnh dưới đây là giao diện chung của MỌI stack. Quy trình dự án
# chỉ gọi các lệnh này, không cần biết bên dưới là gì.
# 
#
# Đường intake, đa target: thân lệnh điều phối xuống srcroot/<nhóm>/<tên>.
# Artifact để CHẠY nằm ở deployment/ (deployment/README.md). Giá trị biến môi trường nằm ở
# deployment/local/.env (không commit) — make nạp vào môi trường, không in ra.

.PHONY: help dev check test migrate deploy doctor gate

PYTHON ?= python
export PYTHONUTF8 = 1

BACKEND := srcroot/boundaries/platform-backend
SHELL_DIR := srcroot/mobile-experiences/shell
COMPOSE := docker compose --env-file deployment/local/.env -f deployment/local/docker-compose.yml
# Nhẹ RAM: bỏ các service Supabase vòng 1 chưa cần (giữ db, auth, rest, kong, edge-runtime, mailpit).
SB_EXCLUDE := studio,realtime,storage-api,imgproxy,vector,logflare,postgres-meta,pgadmin-schema-diff,migra,supavisor
SUPABASE := cd $(BACKEND) && npx --yes supabase@latest

-include deployment/local/.env
export

help:
	@echo "Mina — (vòng 1: spike sync offline)"
	@echo ""
	@echo "  make dev      Supabase + PowerSync (docker) + Metro cho dev build Android"
	@echo "  make check    typecheck shell + build gói hello + tsc"
	@echo "  make test     pgTAP (RLS) + Jest (SQL guard, bridge)"
	@echo "  make migrate  áp migration có version vào DB local"
	@echo "  make deploy   (chưa có nơi deploy — vòng 7)"
	@echo ""
	@echo ""

dev:
	@test -f deployment/local/.env || (echo "Thiếu deployment/local/.env — copy từ deployment/.env.example rồi điền" && exit 1)
	$(SUPABASE) start -x $(SB_EXCLUDE)
	$(COMPOSE) up -d
	@echo ""
	@echo "Backend lên: API http://127.0.0.1:54321 · PowerSync http://127.0.0.1:8090 · mail OTP http://127.0.0.1:54324"
	@echo "Shell: build dev bản Android một lần: (cd $(SHELL_DIR) && npx expo run:android), sau đó Metro:"
	cd $(SHELL_DIR) && EXPO_PUBLIC_SUPABASE_URL=$(SUPABASE_URL) EXPO_PUBLIC_SUPABASE_ANON_KEY=$(SUPABASE_ANON_KEY) EXPO_PUBLIC_POWERSYNC_URL=$(POWERSYNC_URL) npx expo start --dev-client

check:
	node $(SHELL_DIR)/fixtures/miniapp-hello/build.js
	cd $(SHELL_DIR) && npx tsc --noEmit
	@echo "OK: typecheck shell sạch, gói hello đóng được"

test:
	$(SUPABASE) test db
	cd $(SHELL_DIR) && npx jest

migrate:
	$(SUPABASE) migration up --local

deploy:
	@echo "Chưa có nơi deploy — vòng 1–6 chỉ chạy local; deploy lần đầu ở vòng 7 (ROADMAP §1)."
	@exit 1

