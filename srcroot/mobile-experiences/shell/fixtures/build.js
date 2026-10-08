// Đóng gói MỌI fixture (fixtures/miniapp-*/ có manifest.json) thành fixtures/dist/<id>-<version>.zip.
// Chạy: npm run build:fixtures (ở thư mục shell). Zip TÁI LẬP — cùng thư mục cho đúng cùng byte — theo đúng cách
// `buildZip` ở platform-backend/scripts/lib/manifest.ts làm: duyệt có thứ tự tên, bỏ file ẩn, từ chối symlink,
// mtime cố định 2000-01-01, level 6. Zip GỒM `migrations/` (shell cần chạy migration ở máy).
// Gói kèm tokens.css: bản sao của packages/miniapp-sdk/tokens/tokens.css, được đồng bộ vào từng fixture có <link tokens.css>.
const fs = require('fs');
const path = require('path');
const { zipSync } = require('fflate');

const root = __dirname;
const TOKENS = path.join(root, '..', 'packages', 'miniapp-sdk', 'tokens', 'tokens.css');
const MTIME = new Date('2000-01-01T00:00:00Z');

/** Đồng bộ tokens.css vào fixture nào đang `<link href="tokens.css">`. Trả true nếu đã ghi đè. */
function syncTokens(dir) {
  const entry = path.join(dir, JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).entry || 'index.html');
  if (!fs.existsSync(entry) || !/href=["']tokens\.css["']/.test(fs.readFileSync(entry, 'utf8'))) return false;
  const want = fs.readFileSync(TOKENS);
  const dest = path.join(dir, 'tokens.css');
  if (fs.existsSync(dest) && fs.readFileSync(dest).equals(want)) return false;
  fs.writeFileSync(dest, want);
  return true;
}

/** Cùng thuật toán với buildZip của platform-backend (nhưng KHÔNG bỏ migrations/). */
function buildFixtureZip(dir) {
  const files = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      const full = path.join(d, name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(rel + ' là symlink — không đóng gói liên kết tượng trưng');
      if (st.isDirectory()) walk(full);
      else files[rel] = [fs.readFileSync(full), { mtime: MTIME, level: 6 }];
    }
  };
  walk(dir);
  return zipSync(files);
}

function fixtureDirs() {
  return fs
    .readdirSync(root)
    .filter((n) => n.startsWith('miniapp-'))
    .map((n) => path.join(root, n))
    .filter((d) => fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'manifest.json')))
    .sort();
}

function main() {
  const out = path.join(root, 'dist');
  fs.mkdirSync(out, { recursive: true });
  for (const dir of fixtureDirs()) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    for (const k of ['id', 'name', 'version', 'entry']) if (!m[k]) throw new Error(`${path.basename(dir)}: manifest thiếu "${k}"`);
    if (syncTokens(dir)) console.log('đã đồng bộ tokens.css →', path.basename(dir));
    const file = path.join(out, `${m.id}-${m.version}.zip`);
    const zip = Buffer.from(buildFixtureZip(dir));
    fs.writeFileSync(file, zip);
    console.log('đã ghi', path.relative(path.join(root, '..'), file), `(${zip.length} byte)`);
  }
}

module.exports = { buildFixtureZip, fixtureDirs, syncTokens };
if (require.main === module) main();
