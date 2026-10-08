// CLI `registry` — mọi thao tác phát hành / quản trị đi qua đây (chạy trên máy người vận hành, không phải client).
//   npm run registry -- keygen
//   npm run registry -- publish <thư mục app> [--owner <email>]
//   npm run registry -- promote <app> <version>
//   npm run registry -- revoke <app> <version>
//   npm run registry -- add-tester <app> <version> <email>
//   npm run registry -- set-plan <email> <plan>
//   npm run registry -- gen-sync-rules
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { addTester, promote, revoke, setPlan } from "./lib/admin.ts";
import { BACKEND_DIR, config, loadLocalEnv } from "./lib/env.ts";
import { RegistryError } from "./lib/errors.ts";
import { publish } from "./lib/publish.ts";
import { generateKeyFile } from "./lib/sign.ts";
import { loadApps, renderSyncRules } from "./lib/syncrules.ts";

const USAGE = `Dùng: registry <lệnh>
  keygen                              sinh khoá ký thử (SIGNING_KEY_PATH, mặc định deployment/local/keys/)
  publish <thư mục app> [--owner <email>]   zip → ký → Storage → lint + áp migration → app_versions draft
  promote <app> <version>             draft → published
  revoke <app> <version>              → revoked
  add-tester <app> <version> <email>  tenant thấy bản draft
  set-plan <email> <plan>             đổi gói của tenant
  gen-sync-rules                      ghi powersync/sync-rules.yaml từ registry`;

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
    generateKeyFile(path);
    console.log(`Đã sinh khoá ký thử ${cfg.signingKeyId} → ${path} (đã gitignore; khoá công khai đăng ký khi publish lần đầu).`);
    return;
  }

  const need = (n: number): void => {
    if (args.filter((a) => !a.startsWith("--")).length < n) throw new Error(USAGE);
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
      case "promote":
        need(2);
        await promote(db, args[0], args[1]);
        console.log(`Đã promote ${args[0]}@${args[1]} → published.`);
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
      case "gen-sync-rules": {
        const out = resolve(BACKEND_DIR, "powersync", "sync-rules.yaml");
        const apps = await loadApps(db);
        writeFileSync(out, renderSyncRules(apps), "utf8");
        console.log(`Đã ghi ${out} (${apps.length} app). Restart PowerSync để áp dụng:`);
        console.log("  docker compose --env-file deployment/local/.env -f deployment/local/docker-compose.yml restart powersync");
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = cmd ? 2 : 0;
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  if (e instanceof RegistryError) console.error(`Lỗi ${e.code}: ${e.detail}`);
  else console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
