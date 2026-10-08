// registry publish <thư mục app> — zip → sha256 → ký → Storage → lint + áp migration + ghi registry (một transaction).
// Thứ tự để "không áp phần nào khi lint/version hỏng": đọc + lint + kiểm version (chưa chạm gì) → ký → upload
// Storage → transaction DB (migration + apps + app_tables + intent_schemas + app_versions draft).
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { RegistryError } from "./errors.ts";
import { lintMigration } from "./lint.ts";
import { buildZip, derivePrefix, type Manifest, readManifest, receivesOf, semverCompare } from "./manifest.ts";
import { type Config, requireServiceKey } from "./env.ts";
import { loadPrivateKey, publicOf, sha256, signDigest } from "./sign.ts";

export type PublishOptions = { dir: string; ownerEmail?: string };
export type PublishResult = { appId: string; version: string; sha256: string; keyId: string; appliedMigrations: string[]; tables: string[] };

const SYSTEM_COLUMNS: [string, string][] = [
  ["tenant_id", "uuid not null references public.tenants (id)"],
  ["created_at", "timestamptz not null default now()"],
  ["updated_at", "timestamptz not null default now()"],
  ["deleted_at", "timestamptz"],
];

/** Bộ luật server cho một bảng sync (ARCHITECTURE §6): cột hệ thống, RLS, grant, trigger giờ server, publication, sổ app_tables. */
async function hardenSyncTable(db: Client, appId: string, table: string): Promise<void> {
  const q = (s: string) => db.escapeIdentifier(s);
  const t = `public.${q(table)}`;
  const exists = await db.query("select to_regclass($1) as r", [t]);
  if (!exists.rows[0].r) throw new RegistryError("BAD_MANIFEST", `manifest.tables khai bảng ${table} nhưng migration không tạo và DB chưa có`);

  const cols = new Set((await db.query("select column_name from information_schema.columns where table_schema='public' and table_name=$1", [table])).rows.map((r) => r.column_name));
  if (!cols.has("id")) await db.query(`alter table ${t} add column id uuid primary key default gen_random_uuid()`);
  for (const [name, def] of SYSTEM_COLUMNS) {
    if (!cols.has(name)) await db.query(`alter table ${t} add column ${q(name)} ${def}`);
  }
  await db.query(`alter table ${t} enable row level security`);
  await db.query(`drop policy if exists tenant_isolation on ${t}`);
  await db.query(
    `create policy tenant_isolation on ${t}
       using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
       with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)`,
  );
  await db.query(`revoke all on ${t} from anon, authenticated`);
  await db.query(`grant select, insert, update on ${t} to authenticated`); // không DELETE: xoá là xoá mềm
  await db.query(`drop trigger if exists set_updated_at on ${t}`);
  await db.query(`create trigger set_updated_at before insert or update on ${t} for each row execute function public.set_updated_at()`);
  const idx = `${table}_tenant_updated`.slice(0, 63);
  await db.query(`create index if not exists ${q(idx)} on ${t} (tenant_id, updated_at)`);
  const inPub = await db.query("select 1 from pg_publication_tables where pubname='powersync' and schemaname='public' and tablename=$1", [table]);
  if (inPub.rowCount === 0) await db.query(`alter publication powersync add table ${t}`);
  await db.query("insert into public.app_tables (app_id, table_name) values ($1, $2) on conflict (table_name) do nothing", [appId, table]);
}

/** Hai publish cùng app chạy đồng thời sẽ tranh nhau object Storage + version: tuần tự hoá bằng khoá advisory theo app_id. */
export async function publish(db: Client, cfg: Config, opts: PublishOptions): Promise<PublishResult> {
  const manifest = readManifest(opts.dir);
  await db.query("select pg_advisory_lock(hashtextextended($1, 0))", [`publish:${manifest.id}`]);
  try {
    return await publishLocked(db, cfg, opts, manifest);
  } finally {
    await db.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`publish:${manifest.id}`]);
  }
}

async function publishLocked(db: Client, cfg: Config, opts: PublishOptions, manifest: Manifest): Promise<PublishResult> {
  const appId = manifest.id;

  // --- 1. Chưa chạm gì: kiểm app / version / migration ---
  const existing = (await db.query("select table_prefix, owner_tenant_id from public.apps where id = $1", [appId])).rows[0];
  const prefix: string = existing?.table_prefix ?? derivePrefix(appId);
  if (prefix.length > 40) throw new RegistryError("BAD_MANIFEST", `table_prefix ${prefix} dài quá 40 ký tự — rút ngắn id app`);

  const clash = (await db.query("select id from public.apps where table_prefix = $1 and id <> $2", [prefix, appId])).rows[0];
  if (clash) {
    throw new RegistryError("TABLE_PREFIX_CONFLICT", `id ${appId} cho cùng table_prefix "${prefix}" với app ${clash.id} (. và - đều đổi thành _) — chọn id khác`);
  }

  let ownerTenant: string | null = null;
  if (opts.ownerEmail) {
    ownerTenant = (await db.query("select t.id from public.tenants t join auth.users u on u.id = t.owner_user_id where u.email = $1", [opts.ownerEmail])).rows[0]?.id ?? null;
    if (!ownerTenant) throw new RegistryError("TENANT_NOT_FOUND", `không có tenant của ${opts.ownerEmail}`);
  }
  if (existing && (existing.owner_tenant_id ?? null) !== ownerTenant) {
    throw new RegistryError("APP_OWNER_CONFLICT", `app ${appId} đã có chủ sở hữu khác (owner_tenant_id không đổi sau khi tạo)`);
  }

  const maxVer: string[] = (await db.query("select version from public.app_versions where app_id = $1", [appId])).rows.map((r) => r.version);
  if (maxVer.some((v) => semverCompare(v, manifest.version) >= 0)) {
    throw new RegistryError("VERSION_NOT_GREATER", `${appId}@${manifest.version} không lớn hơn bản đã có (${[...maxVer].sort(semverCompare).pop()})`);
  }

  const migDir = join(opts.dir, "migrations");
  const applied = new Map<string, string>(
    (await db.query("select filename, sha256 from public.app_migrations where app_id = $1", [appId])).rows.map((r) => [r.filename, r.sha256]),
  );
  const pending: { filename: string; sha: string; statements: string[]; createdTables: string[] }[] = [];
  if (existsSync(migDir)) {
    for (const filename of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(migDir, filename), "utf8");
      const sha = createHash("sha256").update(sql).digest("hex");
      if (applied.has(filename)) {
        if (applied.get(filename) !== sha) throw new RegistryError("MIGRATION_CHANGED", `${filename} đã áp với nội dung khác — thêm file migration mới thay vì sửa file cũ`);
        continue;
      }
      try {
        pending.push({ filename, sha, ...lintMigration(sql, prefix) }); // ném nếu không cộng thêm → chưa chạm DB, chưa upload
      } catch (e) {
        if (e instanceof RegistryError) throw new RegistryError(e.code, `migrations/${filename}: ${e.detail}`);
        throw e;
      }
    }
  }

  // --- 2. Đóng gói + ký ---
  const zip = buildZip(opts.dir);
  const digest = sha256(zip);
  const priv = loadPrivateKey(cfg.signingKeyPath);
  const pub = publicOf(priv);
  const keyRow = (await db.query("select public_key from public.signing_keys where key_id = $1", [cfg.signingKeyId])).rows[0];
  if (keyRow && keyRow.public_key !== pub) throw new RegistryError("KEY_MISMATCH", `key_id ${cfg.signingKeyId} đã đăng ký với khoá công khai khác`);
  const signature = signDigest(priv, digest);
  const packagePath = `${appId}/${manifest.version}.zip`;

  // --- 3. Upload Storage (ghi đè được: chạy lại publish là idempotent) ---
  const sb = createClient(cfg.supabaseUrl, requireServiceKey(cfg), { auth: { persistSession: false } });
  // Bucket riêng tư `packages`: config.toml khai nhưng chỉ tạo khi seed buckets — CLI tự bảo đảm để không phụ thuộc thứ tự.
  if ((await sb.storage.getBucket("packages")).error) {
    const made = await sb.storage.createBucket("packages", { public: false, fileSizeLimit: "50MB" });
    if (made.error) throw new RegistryError("STORAGE_ERROR", `không tạo được bucket packages: ${made.error.message}`);
  }
  const up = await sb.storage.from("packages").upload(packagePath, zip, { contentType: "application/zip", upsert: true });
  if (up.error) throw new RegistryError("STORAGE_ERROR", `upload ${packagePath} lỗi: ${up.error.message}`);

  // --- 4. Transaction DB ---
  const tables = manifest.tables.map((t) => `${prefix}_${t}`);
  await db.query("begin");
  try {
    if (!keyRow) await db.query("insert into public.signing_keys (key_id, public_key) values ($1, $2)", [cfg.signingKeyId, pub]);
    if (!existing) {
      await db.query(
        "insert into public.apps (id, name, table_prefix, owner_tenant_id, visibility) values ($1, $2, $3, $4, $5)",
        [appId, manifest.name, prefix, ownerTenant, ownerTenant ? "private" : "public"],
      );
    } else {
      await db.query("update public.apps set name = $2 where id = $1", [appId, manifest.name]);
    }
    for (const m of pending) {
      for (const stmt of m.statements) await db.query(stmt);
      await db.query("insert into public.app_migrations (app_id, filename, sha256) values ($1, $2, $3)", [appId, m.filename, m.sha]);
    }
    const toHarden = new Set([...tables, ...pending.flatMap((m) => m.createdTables)]);
    for (const t of toHarden) await hardenSyncTable(db, appId, t);
    for (const i of receivesOf(manifest)) {
      await db.query(
        `insert into public.intent_schemas (type, version, schema, app_id) values ($1, $2, $3, $4)
         on conflict (type, version) do update set schema = excluded.schema where public.intent_schemas.app_id = excluded.app_id`,
        [i.type, i.version, JSON.stringify(i.schema ?? {}), appId],
      );
    }
    await db.query(
      `insert into public.app_versions (app_id, version, sdk_range, package_path, sha256, signature, key_id, manifest, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')`,
      [appId, manifest.version, manifest.sdk, packagePath, digest.toString("hex"), signature, cfg.signingKeyId, JSON.stringify(manifest)],
    );
    await db.query("commit");
  } catch (e) {
    await db.query("rollback");
    const msg = (e as Error).message;
    if (msg === "VERSION_NOT_GREATER") throw new RegistryError("VERSION_NOT_GREATER", `${appId}@${manifest.version} không lớn hơn bản đã có`);
    throw e;
  }

  return { appId, version: manifest.version, sha256: digest.toString("hex"), keyId: cfg.signingKeyId, appliedMigrations: pending.map((m) => m.filename), tables: [...tables] };
}
