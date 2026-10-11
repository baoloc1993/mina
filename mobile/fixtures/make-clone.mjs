// Nhân bản một fixture thành app khác (dùng làm app thứ 3, 4 cho AC-14 — vòng đời nhiều WebView).
// Dùng: node fixtures/make-clone.mjs <thư-mục-nguồn> <id-mới> <tên-mới> <thư-mục-đích>
//   vd: node fixtures/make-clone.mjs fixtures/miniapp-hello vn.app.hello-b "Hello B" fixtures/miniapp-hello-b
// Đổi: manifest.id/name, tiền tố bảng trong migrations (app_<id mới: "." và "-" → "_">), <title>/<h1> của entry, icon.
// Không đổi intents — hai app cùng nhận một type thì shell chọn app cài trước (ARCHITECTURE §5 `intent-*`).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIconPng } from './make-icon.mjs';

const ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$/;

export const defaultPrefix = (id) => 'app_' + id.replace(/[.-]/g, '_').toLowerCase();

/** Tiền tố đang dùng trong migration của nguồn (bảng đầu tiên của manifest.tables), không thấy thì mặc định theo id. */
export function detectPrefix(manifest, sqls) {
  const short = manifest.tables?.[0];
  if (short) {
    const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(app_[A-Za-z0-9_]*?)_${short}\\b`, 'i');
    for (const s of sqls) {
      const m = re.exec(s);
      if (m) return m[1];
    }
  }
  return defaultPrefix(manifest.id);
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const n of readdirSync(src).sort()) {
    if (n.startsWith('.') || n === 'dist') continue;
    const s = join(src, n);
    if (statSync(s).isDirectory()) copyDir(s, join(dest, n));
    else copyFileSync(s, join(dest, n));
  }
}

export function makeClone(srcDir, newId, newName, destDir) {
  srcDir = resolve(srcDir);
  destDir = resolve(destDir);
  if (!ID_RE.test(newId)) throw new Error(`id mới không hợp lệ: "${newId}" (dạng reverse-domain, vd vn.app.hello-b)`);
  if (!newName.trim()) throw new Error('tên mới không được rỗng');
  if (!existsSync(join(srcDir, 'manifest.json'))) throw new Error(`không có manifest.json trong ${srcDir}`);
  if (existsSync(destDir) && readdirSync(destDir).length) throw new Error(`thư mục đích không rỗng: ${destDir}`);
  copyDir(srcDir, destDir);

  const manifestPath = join(destDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const migDir = join(destDir, 'migrations');
  const files = existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')) : [];
  const oldPrefix = detectPrefix(manifest, files.map((f) => readFileSync(join(migDir, f), 'utf8')));
  const newPrefix = defaultPrefix(newId);
  const oldName = manifest.name;

  if (oldPrefix !== newPrefix && manifest.tables?.length) {
    const re = new RegExp(`\\b${oldPrefix}_(${manifest.tables.join('|')})\\b`, 'g');
    for (const f of files) {
      const p = join(migDir, f);
      writeFileSync(p, readFileSync(p, 'utf8').replace(re, `${newPrefix}_$1`));
    }
  }

  manifest.id = newId;
  manifest.name = newName;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const entry = join(destDir, manifest.entry || 'index.html');
  if (existsSync(entry)) {
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const html = readFileSync(entry, 'utf8')
      .replace(new RegExp(`<title>${esc}</title>`), () => `<title>${newName}</title>`)
      .replace(new RegExp(`<h1>${esc}</h1>`), () => `<h1>${newName}</h1>`);
    writeFileSync(entry, html);
  }
  if (manifest.icon) writeFileSync(join(destDir, manifest.icon), makeIconPng(newName.trim()[0] ?? 'H'));

  return { oldPrefix, newPrefix, destDir, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [src, id, name, dest] = process.argv.slice(2);
  if (!src || !id || !name || !dest) {
    console.error('Dùng: node fixtures/make-clone.mjs <thư-mục-nguồn> <id-mới> <tên-mới> <thư-mục-đích>');
    process.exit(1);
  }
  try {
    const r = makeClone(src, id, name, dest);
    console.log(`đã tạo ${basename(r.destDir)}: ${id} (tiền tố bảng ${r.oldPrefix}_ → ${r.newPrefix}_)`);
    console.log('nhớ: npm run build:fixtures để đóng gói, rồi registry publish nếu cần cài thật.');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
