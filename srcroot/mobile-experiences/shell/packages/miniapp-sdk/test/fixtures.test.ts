// Fixture (miniapp-hello 0.2.0, miniapp-hello-cal 0.1.0) + build.js + make-clone.mjs.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, describe, expect, test } from 'vitest';
import { defaultPrefix, makeClone } from '../../../fixtures/make-clone.mjs';
import { KNOWN_SCOPES } from '../../../src/bridge/bridge';
import { inferTablePrefix } from '../mock/src/db';
import { loadFixture } from '../mock/plugin';

const FIX = join(__dirname, '../../../fixtures');
const SDK = join(__dirname, '..');
const req = createRequire(__filename);
const build = req(join(FIX, 'build.js')) as {
  buildFixtureZip(dir: string): Uint8Array;
  fixtureDirs(): string[];
};
const tmp = mkdtempSync(join(tmpdir(), 'mina-fixtures-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HELLO = join(FIX, 'miniapp-hello');
const CAL = join(FIX, 'miniapp-hello-cal');

describe('manifest fixture', () => {
  test.each([HELLO, CAL])('%s: khai đủ trường bắt buộc, scope hợp lệ, có icon PNG 256×256 và migration', (dir) => {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    for (const k of ['id', 'name', 'version', 'sdk', 'entry']) expect(m[k], k).toBeTruthy();
    expect(m.sdk).toBe('^0.1');
    for (const s of m.scopes) expect(KNOWN_SCOPES as readonly string[], s).toContain(s);
    const icon = readFileSync(join(dir, m.icon));
    expect([...icon.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([icon.readUInt32BE(16), icon.readUInt32BE(20)]).toEqual([256, 256]);
    const fx = loadFixture(dir);
    const prefix = inferTablePrefix(fx.manifest, fx.migrations);
    for (const t of m.tables) expect(fx.migrations.some((x) => x.sql.includes(`${prefix}_${t}`)), t).toBe(true);
  });

  test('hello 0.2.0 cố ý không khai core.contacts / core.files / notify.local (ca SCOPE_DENIED thật)', () => {
    const m = JSON.parse(readFileSync(join(HELLO, 'manifest.json'), 'utf8'));
    expect(m.version).toBe('0.2.0');
    expect(m.scopes.filter((s: string) => /^core\.(contacts|files)|^notify/.test(s))).toEqual([]);
    expect(m.tables).toEqual(['items', 'drafts']);
    expect(m.network).toEqual(['vnexpress.net']);
    expect(m.intents.sends.map((i: { type: string }) => i.type)).toEqual(['cal.reminder.create', 'cal.event.open']);
  });

  test('hello-cal nhận đúng hai intent với schema chặt', () => {
    const m = JSON.parse(readFileSync(join(CAL, 'manifest.json'), 'utf8'));
    expect(m.intents.receives.map((i: { type: string }) => i.type)).toEqual(['cal.reminder.create', 'cal.event.open']);
    expect(m.intents.receives[0].schema.additionalProperties).toBe(false);
    expect(m.network).toEqual(['example.com']);
  });

  test('HTML fixture không có mã màu thô và dùng tokens.css', () => {
    for (const dir of [HELLO, CAL]) {
      const html = readFileSync(join(dir, 'index.html'), 'utf8');
      expect(html).toContain('href="tokens.css"');
      expect(html.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], dir).toEqual([]);
      expect(html.match(/\b(rgb|hsl)a?\(/g) ?? [], dir).toEqual([]);
    }
  });

  test('bản sao tokens.css trong fixture khớp tokens.css của SDK (build:fixtures đồng bộ)', () => {
    const want = readFileSync(join(SDK, 'tokens/tokens.css'), 'utf8');
    for (const dir of [HELLO, CAL]) expect(readFileSync(join(dir, 'tokens.css'), 'utf8')).toBe(want);
  });
});

describe('build.js', () => {
  test('đóng gói tái lập và gồm migrations/, icon, tokens.css', () => {
    const a = build.buildFixtureZip(HELLO);
    const b = build.buildFixtureZip(HELLO);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const names = Object.keys(unzipSync(a)).sort();
    expect(names).toEqual(['icon.png', 'index.html', 'manifest.json', 'migrations/001_init.sql', 'tokens.css']);
  });

  test('mọi thư mục miniapp-* có manifest đều được đóng gói', () => {
    const dirs = build.fixtureDirs().map((d) => d.split(/[\\/]/).pop());
    expect(dirs).toEqual(expect.arrayContaining(['miniapp-hello', 'miniapp-hello-cal']));
  });

  test('ra đúng cùng byte với buildZip của platform-backend (CLI registry) cho cùng thư mục', async () => {
    // buildZip của backend duyệt MỌI file (kể cả migrations/ — lệch với câu 'bỏ migrations/' ở ARCHITECTURE §5).
    let backend: { buildZip(dir: string): Uint8Array };
    try {
      backend = await import('../../../../../boundaries/platform-backend/scripts/lib/manifest');
    } catch (e) {
      console.warn('bỏ qua so sánh với backend:', (e as Error).message);
      return;
    }
    expect(Buffer.from(build.buildFixtureZip(HELLO)).equals(Buffer.from(backend.buildZip(HELLO)))).toBe(true);
  });
});

describe('make-clone', () => {
  test('nhân hello thành vn.app.hello-b: đổi id, tên, tiền tố bảng; build được', async () => {
        const dest = join(tmp, 'miniapp-hello-b');
    const r = makeClone(HELLO, 'vn.app.hello-b', 'Hello B', dest);
    expect(r.oldPrefix).toBe('app_hello');
    expect(r.newPrefix).toBe('app_vn_app_hello_b');
    expect(defaultPrefix('vn.app.hello-b')).toBe('app_vn_app_hello_b');

    const m = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ id: 'vn.app.hello-b', name: 'Hello B', version: '0.2.0' });
    const sql = readFileSync(join(dest, 'migrations/001_init.sql'), 'utf8');
    expect(sql).toContain('app_vn_app_hello_b_items');
    expect(sql).toContain('app_vn_app_hello_b_drafts');
    expect(sql).not.toMatch(/\bapp_hello_/);
    const html = readFileSync(join(dest, 'index.html'), 'utf8');
    expect(html).toContain('<title>Hello B</title>');
    expect(html).toContain('<h1>Hello B</h1>');

    // mock suy ra đúng tiền tố mới từ migration đã đổi
    const fx = loadFixture(dest);
    expect(inferTablePrefix(fx.manifest, fx.migrations)).toBe('app_vn_app_hello_b');
    expect(Object.keys(unzipSync(build.buildFixtureZip(dest)))).toContain('migrations/001_init.sql');
  });

  test('nhân hello-cal (tiền tố dài) và chặn id sai / thư mục đích có sẵn', async () => {
        const dest = join(tmp, 'miniapp-cal-c');
    const r = makeClone(CAL, 'vn.app.cal-c', 'Lịch C', dest);
    expect(r.oldPrefix).toBe('app_vn_app_hello_cal');
    expect(readFileSync(join(dest, 'migrations/001_init.sql'), 'utf8')).toContain('app_vn_app_cal_c_reminders');
    expect(() => makeClone(CAL, 'KhongHopLe', 'X', join(tmp, 'x1'))).toThrow(/id mới không hợp lệ/);
    expect(() => makeClone(CAL, 'vn.app.cal-d', 'X', dest)).toThrow(/không rỗng/);
    expect(readdirSync(dest).length).toBeGreaterThan(0);
  });
});
