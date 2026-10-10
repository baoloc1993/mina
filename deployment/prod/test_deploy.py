"""Preflight của deploy.py: chặn deploy nhầm vào local / project khác / khoá dev, không in bí mật.
Chạy:  PYTHONUTF8=1 python -m unittest deployment/prod/test_deploy.py -v
Không chạy lệnh thật: luôn dry=True, allow_dirty=True (không gọi `make check`)."""
import contextlib
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import deploy  # noqa: E402

REF = "abcdefghij0123456789"  # đúng 20 ký tự [a-z0-9]
SECRETS = {
    "SUPABASE_ACCESS_TOKEN": "sbp_SECRETTOKEN_111",
    "SUPABASE_DB_PASSWORD": "DBPASS_SECRET_222",
    "SUPABASE_SERVICE_ROLE_KEY": "SERVICEROLE_SECRET_333",
    "SUPABASE_ANON_KEY": "ANON_SECRET_444",
    "APP_TOKEN_SECRET": "APPTOKEN_SECRET_555",
}


def good_env() -> dict[str, str]:
    return {
        "SUPABASE_PROJECT_REF": REF,
        "SUPABASE_URL": f"https://{REF}.supabase.co",
        "DATABASE_URL": f"postgresql://postgres.{REF}:DBURL_SECRET_666@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
        "SIGNING_KEY_PATH": "deployment/prod/keys/signing-prod.pem",
        "SIGNING_KEY_ID": "prod-1",
        "POWERSYNC_URL": "https://abc123.powersync.journeyapps.com",
        **SECRETS,
    }


def preflight(env: dict[str, str]) -> tuple[str | None, str]:
    """Trả (thông điệp lỗi hoặc None nếu qua, toàn bộ output)."""
    buf = io.StringIO()
    err = None
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        try:
            deploy.Deploy(env, dry=True, allow_dirty=True).preflight()
        except SystemExit as e:
            err = str(e.code)
    return err, buf.getvalue()


class PreflightTest(unittest.TestCase):
    def assertRejected(self, env: dict[str, str], needle: str) -> str:
        err, out = preflight(env)
        self.assertIsNotNone(err, f"preflight lẽ ra phải từ chối ({needle})")
        self.assertIn(needle, err)
        return err + out

    def test_env_dung_thi_qua(self):
        err, _ = preflight(good_env())
        self.assertIsNone(err)

    def test_thieu_bien_bi_tu_choi_va_nen_ten_bien_thieu(self):
        for k in deploy.REQUIRED:
            env = good_env()
            env.pop(k, None)
            with self.subTest(k=k):
                self.assertRejected(env, k)

    def test_bien_rong_cung_la_thieu(self):
        env = good_env()
        env["APP_TOKEN_SECRET"] = ""
        self.assertRejected(env, "APP_TOKEN_SECRET")

    def test_supabase_url_http_bi_tu_choi(self):
        env = good_env()
        env["SUPABASE_URL"] = f"http://{REF}.supabase.co"
        self.assertRejected(env, "SUPABASE_URL")

    def test_supabase_url_local_bi_tu_choi(self):
        for u in ("http://127.0.0.1:54321", "https://localhost", "http://192.168.1.5:54321", "https://[::1]"):
            env = good_env()
            env["SUPABASE_URL"] = u
            with self.subTest(u=u):
                self.assertRejected(env, "SUPABASE_URL")

    def test_supabase_url_khac_project_ref_bi_tu_choi(self):
        env = good_env()
        env["SUPABASE_URL"] = "https://zzzzzzzzzzzzzzzzzzzz.supabase.co"
        self.assertRejected(env, "SUPABASE_URL")

    def test_powersync_http_bi_tu_choi(self):
        env = good_env()
        env["POWERSYNC_URL"] = "http://abc.powersync.journeyapps.com"
        self.assertRejected(env, "POWERSYNC_URL")

    def test_powersync_tro_ve_may_local_hoac_lan_bi_tu_choi(self):
        for u in ("https://localhost:8080", "https://127.0.0.1", "https://[::1]:8080", "https://host.docker.internal",
                  "https://10.0.0.5", "https://172.20.1.1", "https://192.168.0.9"):
            env = good_env()
            env["POWERSYNC_URL"] = u
            with self.subTest(u=u):
                self.assertRejected(env, "POWERSYNC_URL")

    def test_powersync_host_mdns_local_bi_tu_choi(self):
        # LỖI CODE ĐÃ BIẾT: deploy.py:98 có ký tự 0x08 (backspace) dính sau `\.local` trong regex ⇒ `*.local` lọt qua preflight.
        # Khi sửa code, test này thành "unexpected success" ⇒ bỏ decorator expectedFailure đi.
        env = good_env()
        env["POWERSYNC_URL"] = "https://mina.local"
        self.assertRejected(env, "POWERSYNC_URL")

    def test_database_url_local_bi_tu_choi_du_co_chua_ref(self):
        for host in ("localhost", "127.0.0.1", "[::1]", "host.docker.internal", "192.168.1.2", "10.1.2.3", "172.16.0.4"):
            env = good_env()
            env["DATABASE_URL"] = f"postgresql://postgres.{REF}:pw@{host}:54322/postgres"
            with self.subTest(host=host):
                self.assertRejected(env, "DATABASE_URL")

    def test_database_url_thieu_project_ref_bi_tu_choi(self):
        env = good_env()
        env["DATABASE_URL"] = "postgresql://postgres.otherprojectref00000:pw@aws-0.pooler.supabase.com:6543/postgres"
        self.assertRejected(env, "DATABASE_URL")

    def test_khoa_ky_dev_hoac_local_bi_tu_choi(self):
        for kid in ("LOCAL-1", "dev-1", "local-1", "prod-", "prod-x", "prod-1-dev", "xprod-1"):
            env = good_env()
            env["SIGNING_KEY_ID"] = kid
            with self.subTest(kid=kid):
                self.assertRejected(env, "SIGNING_KEY_ID")

    def test_tep_khoa_ky_ten_local_bi_tu_choi(self):
        env = good_env()
        env["SIGNING_KEY_PATH"] = "deployment/local/keys/signing-local.pem"
        self.assertRejected(env, "SIGNING_KEY_PATH")

    def test_loi_khong_in_gia_tri_bi_mat(self):
        # Mỗi ca lỗi dưới đây xảy ra SAU khi mọi biến bí mật đã nạp: không giá trị bí mật nào được lọt ra output.
        bad = []
        e = good_env(); e["SUPABASE_URL"] = "http://localhost"; bad.append(e)
        e = good_env(); e["DATABASE_URL"] = "postgresql://postgres.otherproject00000:DBURL_SECRET_666@h:6543/postgres"; bad.append(e)
        e = good_env(); e["SIGNING_KEY_ID"] = "LOCAL-1"; bad.append(e)
        e = good_env(); e["POWERSYNC_URL"] = "https://localhost"; bad.append(e)
        e = good_env(); e.pop("SUPABASE_URL"); bad.append(e)
        values = list(SECRETS.values()) + ["DBURL_SECRET_666"]
        for env in bad:
            err, out = preflight(env)
            self.assertIsNotNone(err)
            text = err + out
            for v in values:
                with self.subTest(v=v):
                    self.assertNotIn(v, text)

    def test_run_che_bi_mat_trong_lenh_in_ra(self):
        d = deploy.Deploy(good_env(), dry=True, allow_dirty=True)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            d.run(["tool", "--password", SECRETS["SUPABASE_DB_PASSWORD"]], deploy.REPO)
        self.assertNotIn(SECRETS["SUPABASE_DB_PASSWORD"], buf.getvalue())
        self.assertIn("***", buf.getvalue())

    def test_dry_run_khong_chay_lenh_that(self):
        d = deploy.Deploy(good_env(), dry=True, allow_dirty=True)
        with contextlib.redirect_stdout(io.StringIO()):
            r = d.run(["definitely-not-a-real-binary-xyz"], deploy.REPO)
        self.assertEqual(r.returncode, 0)


class LoadEnvTest(unittest.TestCase):
    def test_bo_dau_nhay_va_comment(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / ".env"
            p.write_text('# c\nA="x y"\nB=\'z\'\n\nC=a=b\n', encoding="utf-8")
            self.assertEqual(deploy.load_env(p), {"A": "x y", "B": "z", "C": "a=b"})

    def test_thieu_tep_env_thi_dung(self):
        with self.assertRaises(SystemExit):
            deploy.load_env(Path("khong-co-tep-nay.env"))


if __name__ == "__main__":
    unittest.main()
