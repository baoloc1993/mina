"""Seed local (PRD §7): 2 tenant (a@test.local, b@test.local), mỗi tenant 20 mục app_hello_items.

  python deployment/local/seed/seed.py          # tạo user nếu thiếu + đặt lại 20 mục mỗi tenant
  python deployment/local/seed/seed.py --clean  # xoá sạch mục + 2 user thử (DB về trạng thái rỗng cho dogfood đợt 1)

Khoá lấy từ `supabase status` (không đọc .env, không in ra). Chạy sau `make dev`.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
BACKEND = os.path.join(ROOT, "srcroot", "boundaries", "platform-backend")
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
    sql(f"delete from auth.users where email in ({emails})")  # tenants xoá theo (cascade)
    print("đã xoá mục và 2 user thử")


def seed() -> None:
    env = sb_env()
    for e in USERS:
        admin_create(env, e)
    for i, e in enumerate(USERS):
        tenant = "a" if i == 0 else "b"
        tid = sql(f"select t.id from tenants t join auth.users u on u.id = t.owner_user_id where u.email = '{e}'")
        if not tid:
            sys.exit(f"không thấy tenant của {e}")
        sql(f"delete from app_hello_items where tenant_id = '{tid}'")
        sql(
            "insert into app_hello_items (id, tenant_id, title, done) "
            f"select gen_random_uuid(), '{tid}', 'Mục mẫu {tenant}-' || n, (n % 5 = 0) from generate_series(1, 20) n"
        )
        print(f"  tenant {tenant} ({e}): 20 mục")


if __name__ == "__main__":
    clean() if "--clean" in sys.argv else seed()
