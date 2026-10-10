#!/usr/bin/env python3
"""make deploy — đưa platform lên production (vòng 7, AC-1). Chạy từ máy người vận hành, không CI.

  python deployment/prod/deploy.py                  # deploy đầy đủ (mỗi bước dừng ngay khi lỗi)
  python deployment/prod/deploy.py --dry-run        # chỉ in từng bước sẽ làm, không đổi gì
  python deployment/prod/deploy.py --only functions # chạy MỘT bước (preflight luôn chạy)
  python deployment/prod/deploy.py --skip-android   # bỏ bước build APK
  python deployment/prod/deploy.py create-user a@b.c  # tạo tài khoản (production tắt tự đăng ký — vòng 7)

Biến lấy từ deployment/prod/.env (tên ở deployment/.env.example, hướng dẫn ở deployment/prod/README.md). Không in giá trị bí mật.
Thứ tự bước: preflight → link → db → secrets → functions → auth → registry → powersync → health → android.
Mọi bước idempotent: chạy lại sau khi lỗi giữa chừng là an toàn. Rollback: context/shared/DEPLOY.md §5.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "srcroot" / "boundaries" / "platform-backend"
WEB = REPO / "srcroot" / "web-experiences"
MINIAPPS = [("Ghi chú", WEB / "miniapp-note"), ("Lịch", WEB / "miniapp-calendar"), ("Đọc báo", WEB / "miniapp-news")]
FUNCTIONS = ["catalog", "issue-app-token", "upload", "health"]
STEPS = ["preflight", "link", "db", "secrets", "functions", "auth", "registry", "powersync", "health", "android"]
# Ghim phiên bản CLI (không `@latest`): deploy production không được đổi hành vi theo ngày chạy.
SUPABASE_CLI = "supabase@2.120.0"
NPX = "npx.cmd" if os.name == "nt" else "npx"
NPM = "npm.cmd" if os.name == "nt" else "npm"

REQUIRED = [
    "SUPABASE_PROJECT_REF", "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "SUPABASE_URL", "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL", "APP_TOKEN_SECRET", "SIGNING_KEY_PATH", "SIGNING_KEY_ID", "POWERSYNC_URL",
]
SECRET_NAMES = {"SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "DATABASE_URL",
                "APP_TOKEN_SECRET", "POWERSYNC_ADMIN_TOKEN", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_PASSWORD"}


class Deploy:
    def __init__(self, env: dict[str, str], dry: bool, allow_dirty: bool, skip_check: bool = False) -> None:
        self.env, self.dry, self.allow_dirty, self.skip_check = env, dry, allow_dirty, skip_check
        self.sha = "dev"

    # ---------- tiện ích ----------
    def say(self, msg: str) -> None:
        print(f"{'[dry-run] ' if self.dry else ''}{msg}")

    def run(self, cmd: list[str], cwd: Path, extra_env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess:
        shown = " ".join(cmd)
        for name in SECRET_NAMES:  # không in bí mật ra màn hình / log
            if self.env.get(name):
                shown = shown.replace(self.env[name], "***")
        self.say(f"$ {shown}   (cwd {cwd.relative_to(REPO) if cwd != REPO else '.'})")
        if self.dry:
            return subprocess.CompletedProcess(cmd, 0, "", "")
        env = {**os.environ, **self.env, **(extra_env or {})}
        r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
        out = (r.stdout or "") + (r.stderr or "")
        if r.returncode != 0 and check:
            for name in SECRET_NAMES:  # đề phòng lệnh con in lại bí mật
                if self.env.get(name):
                    out = out.replace(self.env[name], "***")
            sys.exit(f"LỖI ở lệnh: {shown}\n{out.strip()[-1500:]}")
        return r

    def mask(self, text: str) -> str:
        for name in SECRET_NAMES:
            if self.env.get(name):
                text = text.replace(self.env[name], "***")
        return text

    def api(self, method: str, url: str, headers: dict[str, str], body: dict | None = None) -> tuple[int, object]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", "user-agent": "mina-deploy/1 (+supabase-management-api)", **headers})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, raw

    # ---------- các bước ----------
    def preflight(self) -> None:
        miss = [k for k in REQUIRED if not self.env.get(k)]
        if miss:
            sys.exit("Thiếu biến trong deployment/prod/.env: " + ", ".join(miss) + "  (xem deployment/prod/README.md)")
        url, ref = self.env["SUPABASE_URL"], self.env["SUPABASE_PROJECT_REF"]
        if not re.fullmatch(r"https://[a-z0-9]{20}\.supabase\.co/?", url) or ref not in url:
            sys.exit(f"SUPABASE_URL phải dạng https://{ref}.supabase.co (đang khác project ref)")
        if not self.env["POWERSYNC_URL"].startswith("https://"):
            sys.exit("POWERSYNC_URL phải là https://")
        # Máy local / mạng nội bộ ở BẤT KỲ dạng nào: localhost, loopback v4/v6, host.docker.internal, 10.x, 172.16–31.x, 192.168.x, *.local
        local_re = re.compile(r"(?i)(localhost|127\.\d+\.\d+\.\d+|\[::1\]|host\.docker\.internal|(^|[/@.])10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\.local\b)")
        for name in ("DATABASE_URL", "POWERSYNC_URL"):
            if local_re.search(self.env[name]):
                sys.exit(f"{name} đang trỏ về máy local / mạng nội bộ")
        # DATABASE_URL phải thuộc ĐÚNG project của SUPABASE_URL (pooler: user `postgres.<ref>`; trực tiếp: host `db.<ref>.supabase.co`) — tránh publish vào DB khác.
        if ref not in self.env["DATABASE_URL"]:
            sys.exit("DATABASE_URL không chứa project ref của SUPABASE_URL — có thể trỏ nhầm database")
        if not re.fullmatch(r"prod-\d+", self.env["SIGNING_KEY_ID"]):
            sys.exit("SIGNING_KEY_ID phải dạng prod-<số> (vd prod-1), không dùng khoá local/dev")
        if re.search(r"(?i)local", Path(self.env["SIGNING_KEY_PATH"]).name):
            sys.exit("SIGNING_KEY_PATH là tệp khoá local")
        if not Path(self.env["SIGNING_KEY_PATH"]).exists() and not self.dry:
            self.say(f"chưa có khoá ký ở {self.env['SIGNING_KEY_PATH']} — bước registry sẽ sinh bằng `registry keygen`")
        git = subprocess.run(["git", "status", "--porcelain", "--", "srcroot", "deployment/prod"], cwd=REPO, capture_output=True, text=True)
        if git.stdout.strip() and not self.allow_dirty:
            sys.exit("Cây git còn thay đổi chưa commit ở srcroot/ — commit trước (GIT_SHA phải truy được), hoặc --allow-dirty:\n" + git.stdout[:600])
        self.sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip() or "dev"
        self.say(f"preflight OK — project {ref}, GIT_SHA {self.sha}")
        self.say("kiểm kiểu + build: make check" + (" — BỎ QUA (--skip-check: chỉ dùng khi quay về tag đã xanh)" if self.skip_check else ""))
        if not self.dry and not self.skip_check:
            r = subprocess.run(["make", "check"], cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if r.returncode != 0:
                sys.exit("make check đỏ — không deploy:\n" + (r.stdout + r.stderr)[-1200:])

    def link(self) -> None:
        # SUPABASE_ACCESS_TOKEN và SUPABASE_DB_PASSWORD đi qua môi trường của tiến trình con (CLI tự đọc), không qua tham số.
        self.run([NPX, "--yes", SUPABASE_CLI, "link", "--project-ref", self.env["SUPABASE_PROJECT_REF"]], BACKEND)

    def db(self) -> None:
        self.say("migration chỉ CỘNG THÊM (BACKWARD-COMPATIBILITY §2); xem trước danh sách rồi áp")
        self.run([NPX, "--yes", SUPABASE_CLI, "db", "push", "--linked", "--dry-run"], BACKEND)
        self.run([NPX, "--yes", SUPABASE_CLI, "db", "push", "--linked"], BACKEND)
        # Migration nuốt lỗi pg_cron (chỉ NOTICE) nên `db push` xanh dù thiếu job dọn → kiểm tường minh.
        self.say("kiểm job pg_cron (purge-trashed-notes, purge-news-items, purge-rate-limits)")
        self.run([NPM, "--silent", "run", "registry", "--", "cron-check"], BACKEND, {"REGISTRY_ENV": "prod"})

    def secrets(self) -> None:
        pairs = {
            "APP_TOKEN_SECRET": self.env["APP_TOKEN_SECRET"],
            "APP_TOKEN_TTL_SECONDS": self.env.get("APP_TOKEN_TTL_SECONDS", "900"),
            "ENTITLEMENT_GRACE_DAYS": self.env.get("ENTITLEMENT_GRACE_DAYS", "7"),
            "PUBLIC_API_URL": self.env["SUPABASE_URL"].rstrip("/"),
            "GIT_SHA": self.sha,
        }
        for k in ("RATE_LIMIT_UPLOAD_PER_MIN", "RATE_LIMIT_TOKEN_PER_MIN", "RATE_LIMIT_CATALOG_PER_MIN"):
            if self.env.get(k):
                pairs[k] = self.env[k]
        self.say("đặt secret cho Edge Functions: " + ", ".join(pairs))
        if self.dry:
            return
        # Truyền bằng --env-file (0600, xoá ngay) để bí mật không nằm trong tham số dòng lệnh (hiện ở danh sách tiến trình).
        fd, name = tempfile.mkstemp(prefix="mina-secrets-", suffix=".env")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write("".join(f"{k}={v}\n" for k, v in pairs.items()))
            os.chmod(name, 0o600)
            self.run([NPX, "--yes", SUPABASE_CLI, "secrets", "set", "--env-file", name, "--project-ref", self.env["SUPABASE_PROJECT_REF"]], BACKEND)
        finally:
            Path(name).unlink(missing_ok=True)

    def functions(self) -> None:
        for fn in FUNCTIONS:
            self.run([NPX, "--yes", SUPABASE_CLI, "functions", "deploy", fn, "--project-ref", self.env["SUPABASE_PROJECT_REF"], "--no-verify-jwt"], BACKEND)

    def auth(self) -> None:
        """Cấu hình Auth production qua Management API rồi ĐỌC LẠI để kiểm — tên trường sai/không áp được thì dừng ở đây."""
        want = {
            "disable_signup": True,  # vòng 7: tài khoản tạo bằng `create-user`; tự đăng ký là vòng 8
            "site_url": self.env["SUPABASE_URL"].rstrip("/"),
            "jwt_exp": 3600,
            "refresh_token_rotation_enabled": True,
            "hook_custom_access_token_enabled": True,  # claim `tenant_id` — thiếu là mọi API trả NO_TENANT
            "hook_custom_access_token_uri": "pg-functions://postgres/public/custom_access_token_hook",
            "mailer_otp_exp": 3600,
            "mailer_otp_length": 6,
        }
        # Mẫu email có {{ .Token }} (mã 6 số): `config.toml` chỉ có tác dụng ở local — Cloud gửi mẫu mặc định chỉ có LINK, shell không đăng nhập được
        # (bug-hunter vòng 7). Đẩy nội dung `templates/otp.html` + tiêu đề cho mẫu magic_link (người dùng đã có tài khoản) và confirmation.
        tpl = (BACKEND / "supabase" / "templates" / "otp.html").read_text(encoding="utf-8")
        template_keys = ("mailer_templates_magic_link_content", "mailer_templates_confirmation_content")
        for k in template_keys:
            want[k] = tpl
        want["mailer_subjects_magic_link"] = "Mã đăng nhập"
        want["mailer_subjects_confirmation"] = "Mã đăng nhập"
        url = f"https://api.supabase.com/v1/projects/{self.env['SUPABASE_PROJECT_REF']}/config/auth"
        hdr = {"authorization": f"Bearer {self.env['SUPABASE_ACCESS_TOKEN']}"}
        self.say("PATCH " + url + " → " + ", ".join(f"{k}={v}" for k, v in want.items() if k not in template_keys))
        self.say("   + mẫu email có {{ .Token }}: " + ", ".join(template_keys))
        if self.dry:
            return
        st, body = self.api("PATCH", url, hdr, want)
        if st >= 300:
            sys.exit(f"PATCH auth config lỗi {st}: {str(body)[:400]}")
        st, got = self.api("GET", url, hdr)
        if st != 200 or not isinstance(got, dict):
            sys.exit(f"GET auth config lỗi {st}")
        def same(k: str, v: object) -> bool:
            # Mẫu email: API có thể chuẩn hoá khoảng trắng → chỉ đòi còn đúng `{{ .Token }}` (mã 6 số), không so từng byte.
            return ("{{ .Token }}" in str(got.get(k) or "")) if k in template_keys else got.get(k) == v

        bad = {k: ("(muốn)" if k in template_keys else v, "(thực tế)" if k in template_keys else got.get(k)) for k, v in want.items() if not same(k, v)}
        if bad:
            sys.exit("Auth config chưa áp đúng (muốn, thực tế): " + json.dumps(bad, ensure_ascii=False))
        self.say("Auth config đã áp và đọc lại khớp: " + ", ".join(want))

    def registry(self) -> None:
        env = {"REGISTRY_ENV": "prod"}
        self.run([NPM, "--silent", "run", "registry", "--", "keygen"], BACKEND, env)
        for name, d in MINIAPPS:
            dist = d / "dist"
            if not dist.exists() and not self.dry:
                sys.exit(f"{name}: chưa có {dist} — chạy make check (build) trước")
            manifest = json.loads((dist / "manifest.json").read_text(encoding="utf-8")) if dist.exists() else {"id": "?", "version": "?"}
            app, ver = manifest["id"], manifest["version"]
            r = self.run([NPM, "--silent", "run", "registry", "--", "publish", str(dist)], BACKEND, env, check=False)
            txt = (r.stdout or "") + (r.stderr or "")
            if r.returncode != 0 and "VERSION_NOT_GREATER" in txt:
                self.say(f"{name}: {app}@{ver} đã có trên production — bỏ qua publish")
            elif r.returncode != 0:
                sys.exit(f"publish {name} lỗi:\n{self.mask(txt)[-1200:]}")
            p = self.run([NPM, "--silent", "run", "registry", "--", "promote", app, ver], BACKEND, env, check=False)
            ptxt = (p.stdout or "") + (p.stderr or "")
            if p.returncode != 0 and not ("BAD_STATE" in ptxt and "đang published" in ptxt):
                # BAD_STATE vì bản đã `revoked` KHÔNG được coi là xong: production sẽ không có bản an toàn (bug-hunter vòng 7).
                sys.exit(f"promote {name} lỗi:\n{self.mask(ptxt)[-800:]}")
        cfg = REPO / "deployment" / "local" / "seed" / "configs" / "vn.app.news.json"
        # Không đè cấu hình đã chỉnh trên production: chỉ đặt khi chưa có (`{}`); muốn đổi dùng `registry set-config` tay.
        cur = self.run([NPM, "--silent", "run", "registry", "--", "get-config", "vn.app.news"], BACKEND, env, check=False)
        if self.dry or (cur.stdout or "").strip() in ("", "{}", "null"):
            self.run([NPM, "--silent", "run", "registry", "--", "set-config", "vn.app.news", str(cfg)], BACKEND, env)
        else:
            self.say("vn.app.news đã có cấu hình trên production — giữ nguyên (không đè bằng bản seed local)")
        self.run([NPM, "--silent", "run", "registry", "--", "gen-sync-rules"], BACKEND, env)  # ghi deployment/prod/sync-rules.yaml

    def powersync(self) -> None:
        rules = REPO / "deployment" / "prod" / "sync-rules.yaml"
        self.say(f"PowerSync Cloud: đẩy sync rules {rules.relative_to(REPO)} lên instance (dashboard hoặc CLI) — CHƯA tự động, xem DEPLOY.md §2 bước 7")
        self.say("   Sau khi đẩy: đăng nhập app → S6 'Đồng bộ' phải báo đã đồng bộ; `make doctor` phần production kiểm instance.")

    def health(self) -> None:
        url = self.env["SUPABASE_URL"].rstrip("/") + "/functions/v1/health"
        self.say(f"GET {url}  (muốn: 200, ok=true, db=true, version={self.sha})")
        if self.dry:
            return
        st, body = self.api("GET", url, {"apikey": self.env["SUPABASE_ANON_KEY"]})
        if st != 200 or not isinstance(body, dict) or not body.get("ok") or not body.get("db"):
            sys.exit(f"health không đạt: {st} {body}")
        if body.get("version") != self.sha:
            sys.exit(f"health trả version {body.get('version')} ≠ GIT_SHA {self.sha} — Edge Function chưa nạp bản mới")
        self.say("health OK")

    def android(self) -> None:
        self.say("build APK release production: make release-android")
        if not self.dry:
            r = subprocess.run(["make", "release-android"], cwd=REPO)
            if r.returncode != 0:
                sys.exit("make release-android lỗi")

    def create_user(self, email: str) -> None:
        miss = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY") if not self.env.get(k)]
        if miss:
            sys.exit("Thiếu biến: " + ", ".join(miss))
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            sys.exit("email không hợp lệ")
        url = self.env["SUPABASE_URL"].rstrip("/") + "/auth/v1/admin/users"
        key = self.env["SUPABASE_SERVICE_ROLE_KEY"]
        self.say(f"POST {url}  email={email} email_confirm=true")
        if self.dry:
            return
        st, body = self.api("POST", url, {"apikey": key, "authorization": f"Bearer {key}"}, {"email": email, "email_confirm": True})
        if st >= 300:
            sys.exit(f"tạo user lỗi {st}: {str(body)[:300]}")
        print(f"đã tạo tài khoản {email} (id {body.get('id') if isinstance(body, dict) else '?'}) — trigger tự tạo tenant; đăng nhập bằng mã OTP gửi qua email")


def load_env(path: Path) -> dict[str, str]:
    if not path.exists():
        sys.exit(f"Thiếu {path} — xem deployment/prod/README.md")
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def main() -> None:
    # Log ra pipe/file trên Windows mặc định cp1252 → UnicodeEncodeError giữa chừng deploy (dogfood vòng 7).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser(description="deploy production (vòng 7)")
    ap.add_argument("command", nargs="?", choices=["create-user"], help="create-user <email>")
    ap.add_argument("email", nargs="?")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", help="một hoặc nhiều bước, ngăn cách bằng dấu phẩy: " + ",".join(STEPS))
    ap.add_argument("--skip-check", action="store_true", help="bỏ `make check` (chỉ khi quay về tag đã xanh — rollback)")
    ap.add_argument("--skip-android", action="store_true")
    ap.add_argument("--allow-dirty", action="store_true")
    ap.add_argument("--env-file", default=str(Path(__file__).parent / ".env"))
    a = ap.parse_args()
    d = Deploy(load_env(Path(a.env_file)), a.dry_run, a.allow_dirty, a.skip_check)
    if a.command == "create-user":
        if not a.email:
            sys.exit("dùng: deploy.py create-user <email>")
        d.create_user(a.email)
        return
    d.preflight()
    if a.only:
        steps = [x.strip() for x in a.only.split(",") if x.strip()]
        unknown = [x for x in steps if x not in STEPS]
        if unknown:
            sys.exit("--only: bước không có: " + ", ".join(unknown))
    else:
        steps = [s for s in STEPS if not (s == "android" and a.skip_android)]
    for s in steps:
        if s == "preflight":
            continue
        print(f"\n── {s} " + "─" * (60 - len(s)))
        getattr(d, s)()
    print("\nXong." + (" (dry-run: chưa đổi gì)" if a.dry_run else " Kế tiếp: context/shared/DEPLOY.md §6 — kiểm sau deploy."))


if __name__ == "__main__":
    main()
