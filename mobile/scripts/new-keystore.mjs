// Tạo keystore ký APK release và ghi 4 biến ANDROID_KEYSTORE_* vào file .env (không in mật khẩu ra màn hình).
//   node scripts/new-keystore.mjs --path <file.jks> --env <file.env> [--alias mina] [--cn "Mina Platform"]
// Từ chối ghi đè keystore đã có (mất keystore = không cài đè được APK đã phát — ARCHITECTURE §6 vòng 7).
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const path = arg('path');
const envFile = arg('env');
const alias = arg('alias', 'mina');
const cn = arg('cn', 'Mina Platform');
if (!path || !envFile) {
  console.error('dùng: node scripts/new-keystore.mjs --path <file.jks> --env <file.env> [--alias mina] [--cn "Tên"]');
  process.exit(2);
}
const jks = resolve(path);
const envPath = resolve(envFile);
if (existsSync(jks)) {
  console.error(`new-keystore: ${jks} đã tồn tại — không ghi đè (mất khoá = không cài đè được bản đã phát).`);
  process.exit(1);
}
if (existsSync(envPath) && /^ANDROID_KEYSTORE_PATH=/m.test(readFileSync(envPath, 'utf8'))) {
  console.error(`new-keystore: ${envPath} đã có ANDROID_KEYSTORE_PATH — xoá dòng đó nếu thật sự muốn đổi khoá.`);
  process.exit(1);
}
const javaHome = process.env.JAVA_HOME;
const keytool = javaHome ? resolve(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool';
const pass = randomBytes(18).toString('base64url');
mkdirSync(dirname(jks), { recursive: true });
const r = spawnSync(keytool, [
  '-genkeypair', '-v', '-storetype', 'PKCS12', '-keystore', jks, '-alias', alias,
  '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
  '-storepass:env', 'MINA_KS_PASS', '-keypass:env', 'MINA_KS_PASS', '-dname', `CN=${cn}, O=Mina, C=VN`,
], { encoding: 'utf8', env: { ...process.env, MINA_KS_PASS: pass } }); // mật khẩu không nằm trong argv (không hiện ở danh sách tiến trình)
if (r.status !== 0) {
  console.error(`new-keystore: keytool lỗi\n${r.stderr || r.stdout}`);
  process.exit(1);
}
mkdirSync(dirname(envPath), { recursive: true });
appendFileSync(envPath, `\nANDROID_KEYSTORE_PATH=${jks.replace(/\\/g, '/')}\nANDROID_KEYSTORE_PASSWORD=${pass}\nANDROID_KEY_ALIAS=${alias}\nANDROID_KEY_PASSWORD=${pass}\n`);
console.log(`new-keystore: đã tạo ${jks} và ghi 4 biến ANDROID_KEYSTORE_* vào ${envPath}`);
console.log('  → SAO LƯU file .jks + .env ra HAI nơi ngoài repo (kho mật khẩu + ổ khác). Mất là không cài đè được APK đã phát.');
