// Kiểm đầu vào của release-android.mjs (chạy: node --test scripts/release-android.test.mjs).
// Mọi ca ở đây phải thoát TRƯỚC khi gọi prebuild/gradle — nếu script lỡ đi tiếp thì test này đỏ vì ca "không được đi tiếp"
// (ANDROID_HOME trỏ vào thư mục không tồn tại để bước sau đó cũng dừng, không build gì thật).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'release-android.mjs');
const dir = mkdtempSync(join(tmpdir(), 'mina-rel-'));
const keystore = join(dir, 'release.jks');
writeFileSync(keystore, 'not-a-real-keystore');

const GOOD = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://abcdefghij0123456789.supabase.co',
  EXPO_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-xyz',
  EXPO_PUBLIC_POWERSYNC_URL: 'https://x.powersync.journeyapps.com',
  ANDROID_KEYSTORE_PATH: keystore,
  ANDROID_KEYSTORE_PASSWORD: 'KSPASS_SECRET_1',
  ANDROID_KEY_ALIAS: 'mina',
  ANDROID_KEY_PASSWORD: 'KEYPASS_SECRET_2',
};

function run(overrides, args = []) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...GOOD, ...overrides };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  // Không cho kế thừa ANDROID_HOME thật: ca "đủ hợp lệ" phải dừng ở bước thiếu SDK, không build.
  const r = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('thiếu mỗi biến bắt buộc ⇒ dừng, nêu tên biến', () => {
  for (const k of Object.keys(GOOD)) {
    const r = run({ [k]: undefined });
    assert.equal(r.code, 1, k);
    assert.match(r.out, new RegExp(k), k);
  }
});

test('keystore không tồn tại ⇒ dừng', () => {
  const r = run({ ANDROID_KEYSTORE_PATH: join(dir, 'khong-co.jks') });
  assert.equal(r.code, 1);
  assert.match(r.out, /keystore/);
});

test('bản production từ chối URL http (Supabase hoặc PowerSync)', () => {
  for (const k of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_POWERSYNC_URL']) {
    const r = run({ [k]: 'http://abcdefghij0123456789.supabase.co' });
    assert.equal(r.code, 1, k);
    assert.match(r.out, new RegExp(`${k} phải là https`), k);
  }
});

test('bản production từ chối URL https nhưng trỏ về máy local (localhost / 127.0.0.1 / 10.0.2.2)', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.2.2']) {
    const r = run({ EXPO_PUBLIC_POWERSYNC_URL: `https://${host}:8080` });
    assert.equal(r.code, 1, host);
    assert.match(r.out, /trỏ về máy local/, host);
  }
});

test('--local cho phép http (không dừng ở bước kiểm URL; dừng muộn hơn ở bước SDK)', () => {
  const r = run({ EXPO_PUBLIC_SUPABASE_URL: 'http://10.0.2.2:54321', EXPO_PUBLIC_POWERSYNC_URL: 'http://10.0.2.2:8080', ANDROID_HOME: undefined, ANDROID_SDK_ROOT: undefined }, ['--local']);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /https/);
  assert.match(r.out, /ANDROID_HOME/);
});

test('không in giá trị mật khẩu keystore khi từ chối', () => {
  const r = run({ EXPO_PUBLIC_SUPABASE_URL: 'http://x.supabase.co' });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /KSPASS_SECRET_1|KEYPASS_SECRET_2/);
});
