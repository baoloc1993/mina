"""Seed local (PRD §7): 2 tenant (a@test.local, b@test.local) + registry vòng 2.

  python deployment/local/seed/seed.py          # user + khoá ký thử + publish hello / private-a + cài + sync rules + 20 mục hello mỗi tenant
  python deployment/local/seed/seed.py --clean  # xoá mục + 2 user thử (cascade installations/devices); registry giữ nguyên

Registry sau seed: hello 0.0.1 (published, công khai, cài cho cả 2 tenant) · vn.app.private-a 0.0.1 (published, riêng của
tenant-a, cài cho tenant-a). Khoá lấy từ `supabase status` (không đọc .env, không in ra). Chạy sau `make dev`.
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
BACKEND = os.path.join(ROOT, "srcroot", "boundaries", "platform-backend")
HELLO_FIXTURE = os.path.join(ROOT, "srcroot", "mobile-experiences", "shell", "fixtures", "miniapp-hello")
PRIVATE_A = os.path.join(BACKEND, "fixtures", "private-a")
STAGE = os.path.join(ROOT, "deployment", "local", ".build", "hello")
SYNC_RULES = os.path.join(BACKEND, "powersync", "sync-rules.yaml")
DB_CONTAINER = "supabase_db_platform-backend"
USERS = ["a@test.local", "b@test.local"]


def sql(query: str) -> str:
    r = subprocess.run(
        ["docker", "exec", DB_CONTAINER, "psql", "-U", "postgres", "-tAc", query],
        capture_output=True, text=True, encoding="utf-8",
    )
    if r.returncode != 0:
        sys.exit(f"psql lỗi: {r.stderr.strip()}")
    return r.stdout.strip()


def registry(*args: str) -> str:
    """Gọi CLI registry (cwd = backend). Dừng seed nếu lỗi — in nguyên văn lỗi tiếng Việt của CLI."""
    r = subprocess.run(
        ["npm", "run", "--silent", "registry", "--", *args], cwd=BACKEND, shell=(os.name == "nt"),
        capture_output=True, text=True, encoding="utf-8",
    )
    if r.returncode != 0:
        sys.exit(f"registry {' '.join(args)} lỗi: {(r.stderr or r.stdout).strip()}")
    return r.stdout.strip()


def sb_env() -> dict:
    r = subprocess.run(
        "npx --yes supabase@latest status -o env", shell=True, cwd=BACKEND,
        capture_output=True, text=True, encoding="utf-8",
    )
    env = {}
    for line in r.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"')
    if "SERVICE_ROLE_KEY" not in env or "API_URL" not in env:
        sys.exit("Supabase local chưa chạy — chạy `make dev` trước")
    return env


def admin_create(env: dict, email: str) -> None:
    req = urllib.request.Request(
        f"{env['API_URL']}/auth/v1/admin/users",
        data=json.dumps({"email": email, "email_confirm": True}).encode(),
        headers={
            "content-type": "application/json",
            "apikey": env["SERVICE_ROLE_KEY"],
            "authorization": f"Bearer {env['SERVICE_ROLE_KEY']}",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=15)
        print(f"  tạo user {email}")
    except urllib.error.HTTPError as e:
        if e.code in (409, 422):
            print(f"  user {email} đã có")
        else:
            sys.exit(f"tạo {email} lỗi HTTP {e.code}")


def clean() -> None:
    sql("truncate app_hello_items")
    emails = ",".join(f"'{e}'" for e in USERS)
    sql(f"delete from auth.users where email in ({emails})")  # tenants + installations + devices xoá theo (cascade)
    print("đã xoá mục và 2 user thử (registry giữ nguyên)")


def has_version(app: str, version: str) -> bool:
    return bool(sql(f"select 1 from app_versions where app_id = '{app}' and version = '{version}'"))


def stage_hello() -> str:
    """Hello chưa có thư mục đóng gói (build.js chỉ ghi zip vào assets của shell) → dựng thư mục tạm, không sửa shell."""
    shutil.rmtree(STAGE, ignore_errors=True)
    os.makedirs(STAGE)
    shutil.copy(os.path.join(HELLO_FIXTURE, "manifest.json"), STAGE)
    shutil.copy(os.path.join(HELLO_FIXTURE, "src", "index.html"), STAGE)
    return STAGE


def publish_fixture(app: str, version: str, directory: str, owner: str | None = None) -> None:
    if has_version(app, version):
        print(f"  {app}@{version} đã có trong registry")
        return
    args = ["publish", directory] + (["--owner", owner] if owner else [])
    print("  " + registry(*args).splitlines()[0])
    registry("promote", app, version)
    print(f"  promote {app}@{version} → published")


def seed() -> None:
    env = sb_env()
    for e in USERS:
        admin_create(env, e)

    print(registry("keygen"))
    publish_fixture("vn.app.hello", "0.0.1", stage_hello())
    publish_fixture("vn.app.private-a", "0.0.1", PRIVATE_A, owner=USERS[0])

    tenants = {}
    for i, e in enumerate(USERS):
        tid = sql(f"select t.id from tenants t join auth.users u on u.id = t.owner_user_id where u.email = '{e}'")
        if not tid:
            sys.exit(f"không thấy tenant của {e}")
        tenants[e] = tid

    for e, tid in tenants.items():
        sql(f"select public._install_app('{tid}', 'vn.app.hello')")
    sql(f"select public._install_app('{tenants[USERS[0]]}', 'vn.app.private-a')")
    print("  cài vn.app.hello cho cả 2 tenant, vn.app.private-a cho tenant-a")

    before = open(SYNC_RULES, encoding="utf-8").read() if os.path.exists(SYNC_RULES) else ""
    print("  " + registry("gen-sync-rules").splitlines()[0])
    after = open(SYNC_RULES, encoding="utf-8").read()
    if before != after:
        print("  sync-rules đổi → restart PowerSync")
        subprocess.run(
            ["docker", "compose", "--env-file", os.path.join(ROOT, "deployment", "local", ".env"),
             "-f", os.path.join(ROOT, "deployment", "local", "docker-compose.yml"), "restart", "powersync"],
            check=True, capture_output=True,
        )

    for i, (e, tid) in enumerate(tenants.items()):
        tenant = "a" if i == 0 else "b"
        sql(f"delete from app_hello_items where tenant_id = '{tid}'")
        sql(
            "insert into app_hello_items (id, tenant_id, title, done) "
            f"select gen_random_uuid(), '{tid}', 'Mục mẫu {tenant}-' || n, (n % 5 = 0) from generate_series(1, 20) n"
        )
        print(f"  tenant {tenant} ({e}): 20 mục")


if __name__ == "__main__":
    clean() if "--clean" in sys.argv else seed()
