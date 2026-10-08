"""Seed local (PRD §7): 2 tenant (a@test.local, b@test.local) + registry vòng 2.

  python deployment/local/seed/seed.py          # user + khoá ký thử + publish hello / private-a + cài + sync rules + 20 mục hello mỗi tenant
  python deployment/local/seed/seed.py --clean  # xoá mục + 2 user thử (cascade installations/devices); registry giữ nguyên

Registry sau seed (vòng 3): hello (bản trong fixtures/miniapp-hello, published, cài cho cả 2 tenant) · hello-cal 0.1.0 (published,
KHÔNG cài sẵn — cài từ launcher) · vn.app.private-a 0.0.1 (riêng của tenant-a, cài cho tenant-a) · hello 0.5.0 DRAFT có migration
cố ý lỗi trên SQLite (fixtures/miniapp-hello-bad-migration, tenant-a là tester) · vài core_tags cho tenant-a. Chạy lại an toàn:
bản đã có thì bỏ qua. Khoá lấy từ `supabase status` (không đọc .env, không in ra). Chạy sau `make dev`.
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
FIXTURES = os.path.join(ROOT, "srcroot", "mobile-experiences", "shell", "fixtures")
HELLO_CAL_FIXTURE = os.path.join(FIXTURES, "miniapp-hello-cal")
HELLO_BAD_FIXTURE = os.path.join(FIXTURES, "miniapp-hello-bad-migration")
PRIVATE_A = os.path.join(BACKEND, "fixtures", "private-a")
BUILD = os.path.join(ROOT, "deployment", "local", ".build")
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


def stage_fixture(name: str, fixture: str) -> str | None:
    """Dựng thư mục publish từ fixture của shell. Fixture có `src/` (entry nằm trong src) thì entry + file trong src/ được
    đưa lên gốc cạnh manifest.json; `migrations/` đi kèm (gói zip chứa migrations từ vòng 3). Thiếu fixture → None."""
    if not os.path.isfile(os.path.join(fixture, "manifest.json")):
        return None
    stage = os.path.join(BUILD, name)
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage)
    skip = shutil.ignore_patterns("node_modules", "dist", "build.js", ".*")
    src = os.path.join(fixture, "src")
    if os.path.isdir(src):
        shutil.copytree(src, stage, dirs_exist_ok=True, ignore=skip)
        shutil.copy(os.path.join(fixture, "manifest.json"), stage)
        if os.path.isdir(os.path.join(fixture, "migrations")):
            shutil.copytree(os.path.join(fixture, "migrations"), os.path.join(stage, "migrations"))
    else:
        shutil.copytree(fixture, stage, dirs_exist_ok=True, ignore=skip)
    return stage


def manifest_of(directory: str) -> dict:
    with open(os.path.join(directory, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)


def publish_fixture(directory: str | None, label: str, owner: str | None = None, promote: bool = True) -> dict | None:
    """Publish (+ promote) bản trong `directory` nếu registry chưa có version đó. Trả manifest, hoặc None khi thiếu fixture."""
    if directory is None:
        print(f"  CHƯA CHẠY THỬ {label}: thiếu thư mục fixture (shell chưa tạo) — bỏ qua")
        return None
    m = manifest_of(directory)
    app, version = m["id"], m["version"]
    if has_version(app, version):
        print(f"  {app}@{version} đã có trong registry")
        return m
    if sql(f"select 1 from app_versions where app_id = '{app}' and string_to_array(version, '.')::int[] > string_to_array('{version}', '.')::int[] limit 1"):
        print(f"  {app}@{version}: registry đã có version cao hơn — bỏ qua")
        return None
    args = ["publish", directory] + (["--owner", owner] if owner else [])
    print("  " + registry(*args).splitlines()[0])
    if promote:
        registry("promote", app, version)
        print(f"  promote {app}@{version} → published")
    return m


CORE_TAGS = [
    ("00000000-0000-4000-8000-0000000000c1", "việc nhà", "#E57373"),
    ("00000000-0000-4000-8000-0000000000c2", "công việc", "#64B5F6"),
    ("00000000-0000-4000-8000-0000000000c3", "gia đình", "#81C784"),
]


def seed() -> None:
    env = sb_env()
    for e in USERS:
        admin_create(env, e)

    print(registry("keygen"))
    publish_fixture(stage_fixture("hello", HELLO_FIXTURE), "hello (fixtures/miniapp-hello)")
    publish_fixture(stage_fixture("hello-cal", HELLO_CAL_FIXTURE), "hello-cal 0.1.0 (fixtures/miniapp-hello-cal)")
    publish_fixture(PRIVATE_A, "private-a", owner=USERS[0])

    tenants = {}
    for i, e in enumerate(USERS):
        tid = sql(f"select t.id from tenants t join auth.users u on u.id = t.owner_user_id where u.email = '{e}'")
        if not tid:
            sys.exit(f"không thấy tenant của {e}")
        tenants[e] = tid

    def ensure_installed(tid: str, app: str) -> None:
        # Đã cài + bật thì giữ nguyên (không đè cột version bằng bản draft của tester).
        if not sql(f"select 1 from installations where tenant_id = '{tid}' and app_id = '{app}' and enabled"):
            sql(f"select public._install_app('{tid}', '{app}')")

    for e, tid in tenants.items():
        ensure_installed(tid, "vn.app.hello")
    ensure_installed(tenants[USERS[0]], "vn.app.private-a")
    print("  cài vn.app.hello cho cả 2 tenant, vn.app.private-a cho tenant-a (hello-cal chưa cài — cài từ launcher)")

    # hello 0.5.0 DRAFT migration lỗi (test rollback AC-3): chỉ tenant-a thấy. Publish SAU hello 0.4.1 (version phải tăng).
    # Chưa có hello >= 0.4.1 thì KHÔNG publish 0.5.0 (sẽ chặn publish 0.2.0 về sau vì version phải tăng) — chạy lại seed sau.
    hello_ok = sql("select 1 from app_versions where app_id = 'vn.app.hello' and string_to_array(version, '.')::int[] >= array[0,4,1] limit 1")
    bad = None
    if hello_ok:
        bad = publish_fixture(stage_fixture("hello-bad", HELLO_BAD_FIXTURE), "hello 0.5.0 draft (fixtures/miniapp-hello-bad-migration)", promote=False)
    else:
        print("  CHƯA CHẠY THỬ hello 0.5.0 draft: registry chưa có hello >= 0.4.1 (fixture miniapp-hello chưa nâng) — chạy lại seed sau")
    if bad:
        # KHÔNG add-tester ở đây: tester thấy bản draft là bản mới nhất ngay ở catalog và cài thẳng bản lỗi.
        # Test AC-3: cài hello 0.4.1 trước, rồi: npm run registry -- add-tester vn.app.hello 0.5.0 a@test.local
        print(f"  {bad['id']}@{bad['version']} draft (chưa có tester) — thêm tester khi test AC-3 (xem README backend)")

    ta = tenants[USERS[0]]
    for tag_id, name, color in CORE_TAGS:
        sql(f"insert into core_tags (id, tenant_id, name, color) values ('{tag_id}', '{ta}', '{name}', '{color}') on conflict (id) do nothing")
    print(f"  tenant a: {len(CORE_TAGS)} core_tags mẫu")

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
