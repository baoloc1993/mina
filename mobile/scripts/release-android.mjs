// Build APK release ký thật của shell (vòng 7, AC-6). Gọi từ `make release-android` / `make deploy`.
//   node scripts/release-android.mjs [--local]
//   mặc định (production): bắt buộc URL https, keystore release, từ chối rơi về khoá debug.
//   --local: cho phép http (backend docker, cleartext), dùng cho dogfood APK release trên emulator.
// Env bắt buộc: EXPO_PUBLIC_SUPABASE_URL · EXPO_PUBLIC_SUPABASE_ANON_KEY · EXPO_PUBLIC_POWERSYNC_URL ·
//   ANDROID_KEYSTORE_PATH · ANDROID_KEYSTORE_PASSWORD · ANDROID_KEY_ALIAS · ANDROID_KEY_PASSWORD
// Tuỳ chọn: ANDROID_VERSION_CODE (mặc định = số phút từ 2026-01-01 → luôn tăng, không cần sổ đếm), OUT_DIR.
// Thư mục android/ do `expo prebuild` sinh và bị .gitignore → script vá build.gradle MỘT lần (marker MINA-RELEASE),
// idempotent, nên build lại trên máy khác chỉ cần prebuild + chạy script này.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const shellDir = resolve(here, '..');
const repoRoot = resolve(shellDir, '..');
const local = process.argv.includes('--local');
const env = process.env;

// --env-file <file.env>: đọc biến production bằng parser dotenv (không `source` trong shell: mật khẩu có $ & ; ( ) ! sẽ bị shell hiểu sai).
// Biến của file THẮNG môi trường đã nạp (make nạp deployment/local/.env vào mọi recipe → không để khoá/URL local lọt vào bản production).
const envFileIdx = process.argv.indexOf('--env-file');
if (envFileIdx >= 0) {
  const file = process.argv[envFileIdx + 1];
  if (!file || !existsSync(file)) {
    console.error(`release-android: không thấy --env-file ${file ?? '(thiếu đường dẫn)'}`);
    process.exit(1);
  }
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const k of Object.keys(env)) if (/^(ANDROID_|EXPO_PUBLIC_|SUPABASE_|POWERSYNC_)/.test(k)) delete env[k];
  Object.assign(env, parsed);
  env.EXPO_PUBLIC_SUPABASE_URL = parsed.SUPABASE_URL ?? '';
  env.EXPO_PUBLIC_SUPABASE_ANON_KEY = parsed.SUPABASE_ANON_KEY ?? '';
  env.EXPO_PUBLIC_POWERSYNC_URL = parsed.POWERSYNC_URL ?? '';
}

function fail(msg) {
  console.error(`release-android: ${msg}`);
  process.exit(1);
}

// Cờ dòng lệnh (không phụ thuộc shell — `VAR=x lệnh` không chạy trong cmd.exe/PowerShell): --supabase-url · --anon-key · --powersync-url
for (const [flag, key] of [['--supabase-url', 'EXPO_PUBLIC_SUPABASE_URL'], ['--anon-key', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'], ['--powersync-url', 'EXPO_PUBLIC_POWERSYNC_URL']]) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) env[key] = process.argv[i + 1];
}

// ---------- 1. kiểm đầu vào ----------
for (const k of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'EXPO_PUBLIC_POWERSYNC_URL',
  'ANDROID_KEYSTORE_PATH', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
  if (!env[k]) fail(`thiếu biến ${k} (xem deployment/.env.example)`);
}
if (!existsSync(env.ANDROID_KEYSTORE_PATH)) fail(`không thấy keystore ${env.ANDROID_KEYSTORE_PATH}`);
if (!local) {
  for (const k of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_POWERSYNC_URL']) {
    if (!/^https:\/\//.test(env[k])) fail(`${k} phải là https:// cho bản production (dùng --local cho backend docker)`);
  }
  if (/127\.0\.0\.1|10\.0\.2\.2|localhost/.test(env.EXPO_PUBLIC_SUPABASE_URL + env.EXPO_PUBLIC_POWERSYNC_URL)) {
    fail('URL production đang trỏ về máy local');
  }
}
const sdkRoot = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
if (!sdkRoot) fail('thiếu ANDROID_HOME');

const androidDir = join(shellDir, 'android');
if (!existsSync(join(androidDir, 'app', 'build.gradle'))) {
  fail('chưa có android/ — chạy `npx expo prebuild --platform android` một lần rồi chạy lại');
}

// ---------- 1b. đồng bộ android/ với app.json + assets (icon, tên, quyền) ----------
// `expo prebuild` (không --clean) ghi đè phần do Expo sinh và GIỮ file ngoài mẫu; bước vá bên dưới chạy lại sau đó (marker mất khi gradle bị sinh lại).
{
  const isWinPre = process.platform === 'win32';
  const pre = spawnSync(isWinPre ? 'npx.cmd' : 'npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], {
    cwd: shellDir, stdio: 'inherit', shell: isWinPre, env: { ...env, EXPO_NO_TELEMETRY: '1', CI: '1' },
  });
  if (pre.status !== 0) fail(`expo prebuild lỗi (mã ${pre.status})`);
}

// ---------- 2. vá build.gradle một lần ----------
const gradlePath = join(androidDir, 'app', 'build.gradle');
let gradle = readFileSync(gradlePath, 'utf8');
if (!gradle.includes('MINA-RELEASE')) {
  const mustReplace = (from, to) => {
    if (!gradle.includes(from)) fail(`build.gradle không còn đoạn cần vá: ${from.slice(0, 40)}…`);
    gradle = gradle.replace(from, to);
  };
  mustReplace('versionCode 1\n', "versionCode Integer.parseInt(System.getenv('ANDROID_VERSION_CODE') ?: '1') // MINA-RELEASE\n");
  mustReplace(
    '    signingConfigs {\n',
    `    signingConfigs {
        // MINA-RELEASE: khoá release lấy từ biến môi trường (không bao giờ nằm trong repo)
        mina {
            storeFile file(System.getenv('ANDROID_KEYSTORE_PATH') ?: 'debug.keystore')
            storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD') ?: 'android'
            keyAlias System.getenv('ANDROID_KEY_ALIAS') ?: 'androiddebugkey'
            keyPassword System.getenv('ANDROID_KEY_PASSWORD') ?: 'android'
        }
`,
  );
  mustReplace(
    '            // Caution! In production, you need to generate your own keystore file.\n            // see https://reactnative.dev/docs/signed-apk-android.\n            signingConfig signingConfigs.debug\n',
    "            signingConfig signingConfigs.mina // MINA-RELEASE\n            manifestPlaceholders = [minaCleartext: (findProperty('minaCleartext') ?: 'false')]\n",
  );
  writeFileSync(gradlePath, gradle);
  console.log('release-android: đã vá android/app/build.gradle (MINA-RELEASE)');
}

// Manifest riêng cho release: cleartext tắt trừ khi build --local (backend docker dùng http).
const relManifestDir = join(androidDir, 'app', 'src', 'release');
mkdirSync(relManifestDir, { recursive: true });
writeFileSync(
  join(relManifestDir, 'AndroidManifest.xml'),
  `<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
  <application android:usesCleartextTraffic="\${minaCleartext}" tools:replace="android:usesCleartextTraffic" />
</manifest>
`,
);

// ---------- 3. build ----------
const versionCode = env.ANDROID_VERSION_CODE || String(Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 60000) + 1);
const gitSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim() || 'nogit';
const isWin = process.platform === 'win32';
const gradlew = join(androidDir, isWin ? 'gradlew.bat' : 'gradlew');
console.log(`release-android: build ${local ? 'LOCAL (cleartext)' : 'PRODUCTION'} versionCode=${versionCode} sha=${gitSha}`);
const r = spawnSync(
  gradlew,
  ['assembleRelease', '-PreactNativeArchitectures=arm64-v8a,x86_64', `-PminaCleartext=${local ? 'true' : 'false'}`, '--no-daemon', '--console=plain'],
  { cwd: androidDir, stdio: 'inherit', shell: isWin, env: { ...env, ANDROID_VERSION_CODE: versionCode, NODE_ENV: 'production' } },
);
if (r.status !== 0) fail(`gradle assembleRelease lỗi (mã ${r.status})`);

// ---------- 4. kiểm chữ ký rồi chép ra ----------
const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!existsSync(apk)) fail(`không thấy ${apk}`);
const bt = join(sdkRoot, 'build-tools');
const tools = existsSync(bt) ? readdirSync(bt).sort().reverse() : [];
const apksigner = tools.map((t) => join(bt, t, isWin ? 'apksigner.bat' : 'apksigner')).find(existsSync);
if (!apksigner) fail('không thấy apksigner trong build-tools');
const v = spawnSync(apksigner, ['verify', '--verbose', '--print-certs', apk], { encoding: 'utf8', shell: isWin });
const certs = `${v.stdout}${v.stderr}`;
if (v.status !== 0) fail(`apksigner verify hỏng:\n${certs}`);
if (/Android Debug/i.test(certs)) fail('APK đang ký bằng khoá DEBUG — từ chối');
const sha1 = /certificate SHA-256 digest: ([0-9a-f]+)/i.exec(certs)?.[1] ?? '?';
// Ghim dấu vân tay chứng chỉ: keystore sai/sinh lại cho APK ký khác chữ ký → KHÔNG cài đè được lên máy đã cài (mất dữ liệu chưa sync).
const pinned = (env.ANDROID_CERT_SHA256 ?? '').trim().toLowerCase();
if (pinned && pinned !== sha1.toLowerCase()) {
  fail(`chứng chỉ ký ${sha1} KHÁC ANDROID_CERT_SHA256 ${pinned} — keystore sai hoặc đã bị sinh lại; APK này không cài đè được bản đã phát`);
}
if (!pinned && !local) {
  console.log(`release-android: CHƯA ghim chứng chỉ — sau bản production đầu tiên thêm vào deployment/prod/.env:  ANDROID_CERT_SHA256=${sha1}`);
}

const outDir = resolve(env.OUT_DIR || join(repoRoot, 'deployment', local ? 'local' : 'prod', 'releases'));
mkdirSync(outDir, { recursive: true });
const name = `mina-${local ? 'local' : 'prod'}-${versionCode}-${gitSha}.apk`;
const dest = join(outDir, name);
copyFileSync(apk, dest);
// Giữ 2 bản ký gần nhất (rollback shell = cài lại bản trước — DECISIONS C3).
const kept = readdirSync(outDir).filter((f) => f.startsWith(`mina-${local ? 'local' : 'prod'}-`) && f.endsWith('.apk'))
  .map((f) => ({ f, t: statSync(join(outDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
for (const old of kept.slice(2)) unlinkSync(join(outDir, old.f));
const sha = createHash('sha256').update(readFileSync(dest)).digest('hex');
console.log(`release-android: xong → ${dest}`);
console.log(`  kích thước ${(statSync(dest).size / 1048576).toFixed(1)} MB · sha256 APK ${sha}`);
console.log(`  chứng chỉ ký sha256 ${sha1}  (đây là dấu vân tay phải khớp ở mọi bản cài đè)`);
