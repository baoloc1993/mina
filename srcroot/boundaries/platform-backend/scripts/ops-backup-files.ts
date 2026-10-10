// Sao lưu FILE người dùng (bucket Storage `files`) ra đĩa — vì backup database của Supabase KHÔNG chứa nội dung file
// (chỉ bảng `storage.objects` — metadata). Ảnh/PDF đính vào Ghi chú nằm ở đây; mất là mất dữ liệu (H3, vòng 7).
//   npm run ops:backup-files                         (local: deployment/local/backups/files)
//   REGISTRY_ENV=prod npm run ops:backup-files       (production: deployment/prod/backups/files)
// Tăng dần: chỉ tải file mới / đổi kích thước; ghi `manifest.json` {path, size, sha256, fetched_at}. Không xoá file đã sao lưu
// khi nguồn mất (đó chính là lúc cần bản sao). Chạy mỗi tuần (DEPLOY.md §8) và trước mỗi lần thay đổi lớn.
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config, isProd, loadLocalEnv, LOCAL_DIR, PROD_DIR, requireServiceKey } from "./lib/env.ts";

export type ManifestEntry = { path: string; size: number; sha256: string; fetched_at: string };

/** Thuần: file nào cần tải — chưa có trong manifest, hoặc kích thước nguồn khác bản đã lưu. */
export function needsFetch(entry: ManifestEntry | undefined, sourceSize: number): boolean {
  return !entry || entry.size !== sourceSize;
}

/** Thuần: chỉ nhận đường dẫn dạng `<uuid>/<tên>` — không bao giờ thoát khỏi thư mục sao lưu. */
export function safeObjectPath(p: string): boolean {
  return /^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,200}$/.test(p) && !p.includes("..");
}

async function main(): Promise<void> {
  loadLocalEnv();
  const c = config();
  const key = requireServiceKey(c);
  const sb = createClient(c.supabaseUrl, key, { auth: { persistSession: false } });
  const root = join(isProd() ? PROD_DIR : LOCAL_DIR, "backups", "files");
  mkdirSync(root, { recursive: true });
  const manifestPath = join(root, "manifest.json");
  const manifest: Record<string, ManifestEntry> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};

  const bucket = sb.storage.from("files");
  const found: { path: string; size: number }[] = [];
  const top = await bucket.list("", { limit: 1000 });
  if (top.error) throw new Error(`list bucket files: ${top.error.message}`);
  for (const folder of top.data ?? []) {
    if (folder.id !== null) continue; // chỉ thư mục tenant
    for (let offset = 0; ; offset += 1000) {
      const page = await bucket.list(folder.name, { limit: 1000, offset });
      if (page.error) throw new Error(`list ${folder.name}: ${page.error.message}`);
      for (const f of page.data ?? []) {
        if (f.id === null) continue;
        found.push({ path: `${folder.name}/${f.name}`, size: Number(f.metadata?.size ?? -1) });
      }
      if ((page.data ?? []).length < 1000) break;
    }
  }

  let fetched = 0, kept = 0, skipped = 0;
  for (const f of found) {
    if (!safeObjectPath(f.path)) { skipped++; console.error(`  bỏ qua đường dẫn lạ: ${f.path.slice(0, 80)}`); continue; }
    if (!needsFetch(manifest[f.path], f.size)) { kept++; continue; }
    const dl = await bucket.download(f.path);
    if (dl.error || !dl.data) { throw new Error(`tải ${f.path}: ${dl.error?.message ?? "rỗng"}`); }
    const buf = Buffer.from(await dl.data.arrayBuffer());
    const dest = resolve(root, f.path);
    if (!dest.startsWith(root)) throw new Error(`đường dẫn thoát thư mục sao lưu: ${f.path}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    manifest[f.path] = { path: f.path, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), fetched_at: new Date().toISOString() };
    fetched++;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const missingAtSource = Object.keys(manifest).filter((p) => !found.some((f) => f.path === p)).length;
  console.log(`sao lưu file: nguồn ${found.length} · tải mới ${fetched} · đã có ${kept} · bỏ qua ${skipped} · mất ở nguồn nhưng còn bản sao ${missingAtSource}`);
  console.log(`  → ${root} (${Object.keys(manifest).length} file trong manifest, ${statSync(manifestPath).size} byte manifest)`);
}

if (process.argv[1]?.endsWith("ops-backup-files.ts")) {
  main().catch((e) => { console.error("ops:backup-files lỗi:", e instanceof Error ? e.message : e); process.exit(1); });
}
