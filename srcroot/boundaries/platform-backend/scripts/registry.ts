// CLI `registry` — mọi thao tác phát hành / quản trị đi qua đây (chạy trên máy người vận hành, không phải client).
//   npm run registry -- keygen
//   npm run registry -- publish <thư mục app> [--owner <email>]
//   npm run registry -- promote <app> <version>
//   npm run registry -- revoke <app> <version>
//   npm run registry -- add-tester <app> <version> <email>
//   npm run registry -- set-plan <email> <plan>
//   npm run registry -- set-entitlement <email> <ISO|null>
//   npm run registry -- gen-sync-rules
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { addTester, promote, revoke, setEntitlement, setPlan } from "./lib/admin.ts";
import { BACKEND_DIR, config, LOCAL_DIR, loadLocalEnv } from "./lib/env.ts";
import { RegistryError } from "./lib/errors.ts";
import { publish } from "./lib/publish.ts";
import { generateKeyFile } from "./lib/sign.ts";
import { loadApps, renderSyncRules } from "./lib/syncrules.ts";

const USAGE = `Dùng (chạy từ srcroot/boundaries/platform-backend): npm run registry -- <lệnh>
  keygen                              sinh khoá ký thử nếu CHƯA có (chạy lại an toàn: không ghi đè); make dev đã chạy sẵn
  publish <thư mục app> [--owner <email>]   zip → ký → Storage → lint + áp migration → bản draft
                                      <thư mục app> chứa manifest.json + file entry (cạnh nhau) [+ migrations/*.sql]
                                      --owner <email>: app RIÊNG của tenant đó (không có = công khai cho mọi tenant)
  list                                liệt kê app, version, trạng thái (draft | published | revoked), số tenant thử
  add-tester <app> <version> <email>  cho tenant của email thấy bản draft để thử
  promote <app> <version>             draft → published (mọi tenant đủ quyền thấy)
  revoke <app> <version>              → revoked (không quay lại được); <app> = id trong manifest, vd vn.app.hello
  set-plan <email> <plan>             đổi gói của tenant (<plan> là id trong bảng plans, vd mvp-unlimited)
  set-entitlement <email> <ISO|null>  đặt hạn gói của tenant (vd 2026-09-01; quá hạn + 7 ngày ân hạn -> upload 403 READ_ONLY); null = không hết hạn
  gen-sync-rules                      ghi powersync/sync-rules.yaml từ registry; báo có đổi không (đổi mới cần restart PowerSync)`;

const ARGS: Record<string, string> = {
  publish: "publish <thư mục app> [--owner <email>]",
  promote: "promote <app> <version>",
  revoke: "revoke <app> <version>",
  "add-tester": "add-tester <app> <version> <email>",
  "set-plan": "set-plan <email> <plan>",
  "set-entitlement": "set-entitlement <email> <ISO|null>",
};

const HINTS: Record<string, string> = {
  VERSION_NOT_GREATER: "Tăng `version` (semver x.y.z, so từng số) trong manifest.json rồi publish lại.",
  MIGRATION_NOT_ADDITIVE:
    "Chỉ cho phép CREATE TABLE IF NOT EXISTS, ALTER TABLE … ADD COLUMN (nullable hoặc có DEFAULT), CREATE INDEX — trên bảng bắt đầu bằng table_prefix. Muốn đổi/xoá: thêm cột/bảng mới (expand), vòng sau mới gỡ cái cũ.",
  TABLE_OUTSIDE_PREFIX: "Mọi bảng và index của app phải bắt đầu bằng `<table_prefix>_` (mặc định app_ + id đổi . và - thành _).",
  BAD_STATE: "Chỉ draft mới promote/thêm tenant thử; bản đã revoked là cuối cùng — publish version mới (lớn hơn).",
  BAD_DATE: "Dùng ngày ISO (2026-09-01 hoặc 2026-09-01T00:00:00Z) hoặc chữ null để bỏ hạn.",
  TENANT_NOT_FOUND: "Email phải là tài khoản đã đăng nhập ít nhất một lần (mỗi user có một tenant).",
  SIGNING_KEY_MISSING: "Chạy `npm run registry -- keygen` (hoặc đặt SIGNING_KEY_PATH tới file PEM Ed25519).",
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = config();

  if (cmd === "keygen") {
    const path = cfg.signingKeyPath!;
    if (existsSync(path)) {
      console.log(`Khoá ký đã có ở ${path} — giữ nguyên.`);
      return;
    }
    try {
      generateKeyFile(path);
    } catch (e) {
      throw new RegistryError("KEYGEN_FAILED", `không ghi được khoá ở ${path}: ${(e as Error).message}`);
    }
    console.log(`Đã sinh khoá ký thử ${cfg.signingKeyId} → ${path} (đã gitignore; khoá công khai đăng ký khi publish lần đầu).`);
    return;
  }

  if (cmd && !(cmd in ARGS) && !["keygen", "list", "gen-sync-rules"].includes(cmd)) {
    throw new RegistryError("UNKNOWN_COMMAND", `không có lệnh "${cmd}"\n${USAGE}`);
  }
  const need = (n: number): void => {
    const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--owner"));
    if (positional.length < n) throw new RegistryError("MISSING_ARGS", `thiếu tham số — dùng: registry ${ARGS[cmd]}`);
  };
  const db = new pg.Client({ connectionString: cfg.databaseUrl });
  await db.connect();
  try {
    switch (cmd) {
      case "publish": {
        need(1);
        const r = await publish(db, cfg, { dir: resolve(args[0]), ownerEmail: flag(args, "--owner") });
        console.log(`Đã publish ${r.appId}@${r.version} (draft) · sha256 ${r.sha256.slice(0, 12)}… · key ${r.keyId}`);
        console.log(`  bảng: ${r.tables.join(", ") || "(không)"} · migration mới: ${r.appliedMigrations.join(", ") || "(không)"}`);
        console.log(`  Tiếp: add-tester ${r.appId} ${r.version} <email> để tenant thử thấy, hoặc promote ${r.appId} ${r.version}.`);
        console.log("  Nếu app có bảng mới: chạy gen-sync-rules rồi restart PowerSync.");
        break;
      }
      case "list": {
        const rows = (
          await db.query(
            `select a.id, a.visibility, v.version, v.status,
                    (select count(*)::int from public.app_version_testers t where t.app_id = v.app_id and t.version = v.version) as testers
               from public.apps a left join public.app_versions v on v.app_id = a.id
              where a.id <> '_core'
              order by a.id, string_to_array(v.version, '.')::int[]`,
          )
        ).rows;
        if (rows.length === 0) console.log("Registry trống — chưa có app nào. Bắt đầu: publish <thư mục app>.");
        for (const r of rows) {
          const kind = r.visibility === "private" ? "riêng" : "công khai";
          const ver = r.version ? `${r.version}  ${r.status}${r.status === "draft" ? `  ${r.testers} tenant thử` : ""}` : "— chưa có version";
          console.log(`${r.id} (${kind}) ${ver}`);
        }
        break;
      }
      case "promote":
        need(2);
        await promote(db, args[0], args[1]);
        console.log(`Đã promote ${args[0]}@${args[1]} → published (mọi tenant đủ quyền thấy bản này).`);
        console.log(`  Tiếp: kiểm GET /functions/v1/catalog; app có bảng mới → gen-sync-rules rồi restart PowerSync; nếu lỗi: revoke ${args[0]} ${args[1]}.`);
        break;
      case "revoke":
        need(2);
        await revoke(db, args[0], args[1]);
        console.log(`Đã thu hồi ${args[0]}@${args[1]}.`);
        break;
      case "add-tester":
        need(3);
        await addTester(db, args[0], args[1], args[2]);
        console.log(`Tenant của ${args[2]} thấy được bản draft ${args[0]}@${args[1]}.`);
        break;
      case "set-plan":
        need(2);
        await setPlan(db, args[0], args[1]);
        console.log(`Đã đổi gói của ${args[0]} → ${args[1]}.`);
        break;
      case "set-entitlement": {
        need(2);
        const until = await setEntitlement(db, args[0], args[1]);
        console.log(until ? `Đã đặt hạn gói của ${args[0]} = ${until} (catalog trả until này; upload chuyển chỉ đọc sau ân hạn).` : `Đã bỏ hạn gói của ${args[0]} (entitlement_until = null, không hết hạn).`);
        break;
      }
      case "gen-sync-rules": {
        const out = resolve(BACKEND_DIR, "powersync", "sync-rules.yaml");
        const apps = await loadApps(db);
        const next = renderSyncRules(apps);
        const prev = existsSync(out) ? readFileSync(out, "utf8").replace(/\r\n/g, "\n") : "";
        if (prev === next) {
          console.log(`Sync rules không đổi (${apps.length} app) — không cần restart PowerSync.`);
          break;
        }
        writeFileSync(out, next, "utf8");
        const names = (y: string) => new Set([...y.matchAll(/^  (\w+):$/gm)].map((m) => m[1]));
        const before = names(prev), after = names(next);
        const added = [...after].filter((x) => !before.has(x)).join(", ") || "(không)";
        const removed = [...before].filter((x) => !after.has(x)).join(", ") || "(không)";
        console.log(`Đã ghi ${out} (${apps.length} app) — thêm bucket: ${added} · bỏ: ${removed}.`);
        console.log("Restart PowerSync để áp dụng (chạy ở thư mục nào cũng được):");
        console.log(`  docker compose --env-file "${resolve(LOCAL_DIR, ".env")}" -f "${resolve(LOCAL_DIR, "docker-compose.yml")}" restart powersync`);
        break;
      }
      default:
        console.log(USAGE);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  if (e instanceof RegistryError) {
    console.error(`Lỗi ${e.code}: ${e.detail}`);
    if (HINTS[e.code]) console.error(`  → ${HINTS[e.code]}`);
  }
  else console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
