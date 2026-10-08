import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { strToU8, zipSync } from 'fflate';
import { DatabaseSync } from 'node:sqlite';
import { PackageManager, type PmDeps } from './manager';
import { PackageError, type AppRow, type CatalogApp, type Fs, type SqlRunner } from './types';
import { bytesToB64, extractZip, lintMigration, safeRelPath } from './verify';

// ---------- đồ giả ----------
class MemFs implements Fs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  async mkdirp(p: string) {
    this.dirs.add(p.replace(/\/$/, ''));
  }
  async writeBytes(p: string, b: Uint8Array) {
    this.files.set(p, b);
  }
  async readText(p: string) {
    const f = this.files.get(p);
    if (!f) throw new Error('ENOENT ' + p);
    return new TextDecoder().decode(f);
  }
  async exists(p: string) {
    const q = p.replace(/\/$/, '');
    return this.files.has(p) || this.dirs.has(q) || [...this.files.keys()].some((k) => k.startsWith(q + '/'));
  }
  async rm(p: string) {
    const q = p.replace(/\/$/, '');
    for (const k of [...this.files.keys()]) if (k === q || k.startsWith(q + '/')) this.files.delete(k);
    for (const k of [...this.dirs]) if (k === q || k.startsWith(q + '/')) this.dirs.delete(k);
  }
  async rename(from: string, to: string) {
    const f = from.replace(/\/$/, '');
    const t = to.replace(/\/$/, '');
    for (const [k, v] of [...this.files]) {
      if (k.startsWith(f + '/')) {
        this.files.delete(k);
        this.files.set(t + k.slice(f.length), v);
      }
    }
    this.dirs.add(t);
  }
  async list(p: string) {
    const q = p.replace(/\/$/, '') + '/';
    return [...new Set([...this.files.keys()].filter((k) => k.startsWith(q)).map((k) => k.slice(q.length).split('/')[0]))];
  }
  has(prefix: string) {
    return [...this.files.keys()].some((k) => k.startsWith(prefix));
  }
}

function sqliteRunner(): SqlRunner {
  const db = new DatabaseSync(':memory:');
  return {
    exec: (sql) => void db.exec(sql),
    tables: () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name),
    columns: (t) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string }[]).map((r) => ({ name: r.name, type: r.type })),
    close: () => db.close(),
  };
}

const priv = ed.utils.randomSecretKey();
const pub = ed.getPublicKey(priv);
const KEYS = { 'local-1': bytesToB64(pub) };

interface PkgOpts {
  id?: string;
  version: string;
  sdk?: string;
  migrations?: Record<string, string>;
  tables?: string[];
  extra?: Record<string, Uint8Array>;
}
function makeApp(o: PkgOpts): { app: CatalogApp; zip: Uint8Array } {
  const id = o.id ?? 'vn.app.hello';
  const manifest = {
    id,
    name: 'Hello',
    version: o.version,
    sdk: o.sdk ?? '^0.1',
    entry: 'index.html',
    scopes: ['db.own'],
    tables: o.tables ?? ['items'],
  };
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'index.html': strToU8('<html></html>'),
    ...Object.fromEntries(
      Object.entries(o.migrations ?? { '001_init.sql': 'CREATE TABLE IF NOT EXISTS app_hello_items (id text primary key, title text not null, done integer default 0);' }).map(
        ([k, v]) => ['migrations/' + k, strToU8(v)],
      ),
    ),
    ...(o.extra ?? {}),
  };
  const zip = zipSync(files);
  const digest = sha256(zip);
  const app: CatalogApp = {
    id,
    name: 'Hello',
    table_prefix: 'app_hello',
    owner_tenant_id: null,
    version: o.version,
    sdk_range: o.sdk ?? '^0.1',
    package_url: `https://pkg/${id}/${o.version}.zip`,
    sha256: bytesToHex(digest),
    signature: bytesToB64(ed.sign(digest, priv)),
    key_id: 'local-1',
    status: 'published',
    installed: false,
    enabled: false,
  };
  return { app, zip };
}

function setup() {
  const fs = new MemFs();
  const rows = new Map<string, AppRow>();
  const downloads = new Map<string, Uint8Array>();
  const failures: string[][] = [];
  let schemaChanges = 0;
  let installCalls = 0;
  let installError: Error | null = null;
  let offline = false;
  const deps: PmDeps = {
    appsDir: 'file:///docs/apps/',
    fs,
    download: async (url) => {
      if (offline) throw new PackageError('OFFLINE', 'mất mạng');
      const b = downloads.get(url);
      if (!b) throw new PackageError('PACKAGE_UNAVAILABLE', 'không có gói');
      return b;
    },
    api: {
      installApp: async () => {
        installCalls++;
        if (installError) throw installError;
      },
      uninstallApp: async () => {
        if (offline) throw new PackageError('OFFLINE', 'mất mạng');
      },
    },
    trustedKeys: async () => KEYS,
    newScratch: sqliteRunner,
    repo: {
      list: async () => [...rows.values()],
      get: async (id) => rows.get(id) ?? null,
      put: async (r) => void rows.set(r.app_id, r),
      remove: async (id) => void rows.delete(id),
    },
    onSchemaChanged: async () => void schemaChanges++,
    now: () => '2026-10-09T00:00:00.000Z',
    rand: () => 'r',
    recordFailure: async (a, v, c, d) => void failures.push([a, v, c, d]),
  };
  const pm = new PackageManager(deps);
  const publish = (o: PkgOpts) => {
    const p = makeApp(o);
    downloads.set(p.app.package_url as string, p.zip);
    return p;
  };
  return {
    fs, rows, pm, publish, failures, downloads,
    get schemaChanges() { return schemaChanges; },
    get installCalls() { return installCalls; },
    setInstallError: (e: Error | null) => { installError = e; },
    setOffline: (v: boolean) => { offline = v; },
  };
}

const DIR = 'file:///docs/apps/vn.app.hello/';

describe('AC-2 cài với gói ký thật', () => {
  test('cài thành công: 4 bước, thư mục version, bảng suy ra từ migration, RPC, schema đổi', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0' });
    const steps: string[] = [];
    const row = await t.pm.install(app, (s) => steps.push(s));
    expect(steps).toEqual(['download', 'verify', 'extract', 'migrate', 'register', 'done']);
    expect(row.current_version).toBe('0.2.0');
    expect(t.fs.has(DIR + '0.2.0/index.html')).toBe(true);
    expect(t.fs.has(DIR + '0.2.0/migrations/001_init.sql')).toBe(true);
    expect(t.installCalls).toBe(1);
    expect(t.schemaChanges).toBe(1);
    const tbl = row.tables.find((x) => x.name === 'app_hello_items');
    expect(tbl?.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['title', 'done', 'tenant_id', 'created_at', 'updated_at', 'deleted_at']));
    expect(tbl?.columns.find((c) => c.name === 'done')?.kind).toBe('integer');
    expect(tbl?.columns.find((c) => c.name === 'id')).toBeUndefined();
  });

  test('gói bị sửa 1 byte → PACKAGE_TAMPERED, không ghi gì', async () => {
    const t = setup();
    const { app, zip } = t.publish({ version: '0.2.0' });
    const bad = zip.slice();
    bad[Math.floor(bad.length / 2)] ^= 1;
    t.downloads.set(app.package_url as string, bad);
    await expect(t.pm.install(app)).rejects.toMatchObject({ code: 'PACKAGE_TAMPERED' });
    expect(t.fs.files.size).toBe(0);
    expect(t.rows.size).toBe(0);
    expect(t.installCalls).toBe(0);
  });

  test('sha256 + zip bị thay cùng lúc nhưng chữ ký cũ → PACKAGE_TAMPERED', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0' });
    const evil = zipSync({ 'manifest.json': strToU8('{}'), 'index.html': strToU8('x') });
    t.downloads.set(app.package_url as string, evil);
    await expect(t.pm.install({ ...app, sha256: bytesToHex(sha256(evil)) })).rejects.toMatchObject({ code: 'PACKAGE_TAMPERED' });
    expect(t.fs.files.size).toBe(0);
  });

  test('khoá không trong danh sách tin cậy → UNTRUSTED_KEY', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0' });
    await expect(t.pm.install({ ...app, key_id: 'khoa-la' })).rejects.toMatchObject({ code: 'UNTRUSTED_KEY' });
    expect(t.fs.files.size).toBe(0);
  });

  test('sdk range cao hơn shell → SDK_TOO_OLD', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0', sdk: '^0.2' });
    await expect(t.pm.install(app)).rejects.toMatchObject({ code: 'SDK_TOO_OLD' });
    expect(t.rows.size).toBe(0);
  });

  test('QUOTA_EXCEEDED từ server → xoá gói đã giải nén, không icon', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0' });
    t.setInstallError(new PackageError('QUOTA_EXCEEDED', 'hết quota'));
    await expect(t.pm.install(app)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(t.fs.files.size).toBe(0);
    expect(t.rows.size).toBe(0);
    expect(t.schemaChanges).toBe(0);
  });

  test('mất mạng khi tải → OFFLINE, không còn vết', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0' });
    t.setOffline(true);
    await expect(t.pm.install(app)).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(t.fs.files.size).toBe(0);
  });

  test('migration không cộng thêm (DROP) → MIGRATION_NOT_ADDITIVE, không còn vết', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0', migrations: { '001.sql': 'DROP TABLE app_hello_items;' } });
    await expect(t.pm.install(app)).rejects.toMatchObject({ code: 'MIGRATION_NOT_ADDITIVE' });
    expect(t.fs.files.size).toBe(0);
  });

  test('migration lỗi thật trong SQLite → MIGRATION_FAILED, không còn vết', async () => {
    const t = setup();
    const { app } = t.publish({
      version: '0.2.0',
      migrations: { '001.sql': 'CREATE TABLE IF NOT EXISTS app_hello_items (id text primary key);', '002.sql': 'ALTER TABLE app_hello_items ADD COLUMN stamped_at timestamptz DEFAULT now();' },
    });
    await expect(t.pm.install(app)).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    expect(t.fs.files.size).toBe(0);
  });

  test('manifest.tables khai bảng mà migration không tạo → BAD_MANIFEST', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0', tables: ['items', 'ghost'] });
    await expect(t.pm.install(app)).rejects.toMatchObject({ code: 'BAD_MANIFEST' });
  });

  test('NO_SAFE_VERSION và thiếu package_url bị từ chối trước khi tải', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0' });
    await expect(t.pm.install({ ...app, version: null, code: 'NO_SAFE_VERSION' })).rejects.toMatchObject({ code: 'NO_SAFE_VERSION' });
    await expect(t.pm.install({ ...app, package_url: null })).rejects.toMatchObject({ code: 'PACKAGE_UNAVAILABLE' });
  });
});

describe('an toàn giải nén', () => {
  test.each(['../evil.txt', '/abs.txt', 'a/../../b', 'a\\b', 'C:/x', 'a//b', './x'])('zip-slip %s bị từ chối', (name) => {
    expect(safeRelPath(name)).toBeNull();
    const zip = zipSync({ [name]: strToU8('x') });
    expect(() => extractZip(zip)).toThrow(PackageError);
  });
  test('đường dẫn hợp lệ', () => {
    expect(safeRelPath('migrations/001_init.sql')).toBe('migrations/001_init.sql');
  });
  test('lint migration: chỉ cộng thêm trong tiền tố', () => {
    expect(() => lintMigration('CREATE TABLE IF NOT EXISTS app_hello_x (id text);', 'app_hello')).not.toThrow();
    for (const sql of [
      'CREATE TABLE IF NOT EXISTS other_x (id text);',
      'DROP TABLE app_hello_items;',
      'ALTER TABLE app_hello_items RENAME TO y;',
      'ALTER TABLE app_hello_items ADD COLUMN c text NOT NULL;',
      'DELETE FROM app_hello_items;',
      'CREATE TABLE app_hello_x (id text);',
      'PRAGMA key = 1;',
      'CREATE TABLE IF NOT EXISTS app_hello_x (id text); ATTACH DATABASE "a" AS b;',
    ]) {
      expect(() => lintMigration(sql, 'app_hello')).toThrow(PackageError);
    }
  });
});

describe('AC-3 cập nhật + rollback', () => {
  async function installed(t: ReturnType<typeof setup>) {
    const { app } = t.publish({ version: '0.2.0' });
    await t.pm.install(app);
    return app;
  }

  test('catalog có bản cao hơn → tải ngầm thành pending, app đang chạy KHÔNG đổi; lần mở sau hoán đổi', async () => {
    const t = setup();
    await installed(t);
    const { app: v3 } = t.publish({
      version: '0.3.0',
      migrations: { '001_init.sql': 'CREATE TABLE IF NOT EXISTS app_hello_items (id text primary key, title text not null, done integer default 0);', '002_note.sql': 'ALTER TABLE app_hello_items ADD COLUMN note text;' },
    });
    const ev = await t.pm.reconcile([v3]);
    expect(ev).toEqual([{ kind: 'pending', appId: 'vn.app.hello', version: '0.3.0' }]);
    let row = t.rows.get('vn.app.hello') as AppRow;
    expect(row.current_version).toBe('0.2.0');
    expect(row.pending_version).toBe('0.3.0');
    expect(t.fs.has(DIR + '0.3.0/index.html')).toBe(true);
    const before = t.schemaChanges;

    const opened = await t.pm.prepareOpen('vn.app.hello');
    row = opened.row;
    expect(row.current_version).toBe('0.3.0');
    expect(row.previous_version).toBe('0.2.0');
    expect(row.pending_version).toBeNull();
    expect(row.notice).toBe('updated');
    expect(opened.dir).toBe(DIR + '0.3.0/');
    expect(row.tables[0].columns.map((c) => c.name)).toContain('note');
    expect(t.schemaChanges).toBe(before + 1);
    expect(t.fs.has(DIR + '0.2.0/index.html')).toBe(true); // giữ 1 bản trước
  });

  test('chỉ giữ đúng 2 bản: lên 0.4.0 thì 0.2.0 bị xoá', async () => {
    const t = setup();
    await installed(t);
    const m = { '001_init.sql': 'CREATE TABLE IF NOT EXISTS app_hello_items (id text primary key, title text not null, done integer default 0);' };
    await t.pm.reconcile([t.publish({ version: '0.3.0', migrations: m }).app]);
    await t.pm.prepareOpen('vn.app.hello');
    await t.pm.reconcile([t.publish({ version: '0.4.0', migrations: m }).app]);
    await t.pm.prepareOpen('vn.app.hello');
    expect(t.fs.has(DIR + '0.2.0/')).toBe(false);
    expect(t.fs.has(DIR + '0.3.0/')).toBe(true);
    expect(t.fs.has(DIR + '0.4.0/')).toBe(true);
  });

  test('migration bản mới lỗi → UPDATE_FAILED, xoá thư mục mới, bản cũ chạy bình thường, ghi hàng đợi lỗi', async () => {
    const t = setup();
    await installed(t);
    const { app: bad } = t.publish({
      version: '0.3.0',
      migrations: {
        '001_init.sql': 'CREATE TABLE IF NOT EXISTS app_hello_items (id text primary key, title text not null, done integer default 0);',
        '002_bad.sql': 'ALTER TABLE app_hello_items ADD COLUMN stamped_at timestamptz DEFAULT now();',
      },
    });
    await t.pm.reconcile([bad]);
    const { row, dir } = await t.pm.prepareOpen('vn.app.hello');
    expect(row.current_version).toBe('0.2.0');
    expect(row.pending_version).toBeNull();
    expect(row.status).toBe('update_failed');
    expect(row.last_error).toBe('UPDATE_FAILED');
    expect(dir).toBe(DIR + '0.2.0/');
    expect(t.fs.has(DIR + '0.3.0/')).toBe(false);
    expect(t.failures[0].slice(0, 3)).toEqual(['vn.app.hello', '0.3.0', 'UPDATE_FAILED']);
    // app vẫn mở được lần nữa
    await expect(t.pm.prepareOpen('vn.app.hello')).resolves.toBeTruthy();
  });

  test('bản đang chạy bị thu hồi, có bản trước trên máy → về bản trước', async () => {
    const t = setup();
    const v2 = (await installed(t));
    const m = { '001_init.sql': 'CREATE TABLE IF NOT EXISTS app_hello_items (id text primary key, title text not null, done integer default 0);' };
    const v3 = t.publish({ version: '0.3.0', migrations: m }).app;
    await t.pm.reconcile([v3]);
    await t.pm.prepareOpen('vn.app.hello'); // đang chạy 0.3.0, trước = 0.2.0
    // 0.3.0 bị thu hồi → catalog trả 0.2.0
    const ev = await t.pm.reconcile([{ ...v2 }]);
    expect(ev).toEqual([{ kind: 'pending', appId: 'vn.app.hello', version: '0.2.0' }]);
    const { row } = await t.pm.prepareOpen('vn.app.hello');
    expect(row.current_version).toBe('0.2.0');
    expect(row.previous_version).toBeNull();
    expect(t.fs.has(DIR + '0.3.0/')).toBe(false); // bản thu hồi không được giữ
  });

  test('bản đang chạy bị thu hồi, không có bản trước → tải bản catalog như cập nhật (hạ cấp)', async () => {
    const t = setup();
    await installed(t); // 0.2.0 duy nhất
    const m = { '001_init.sql': 'CREATE TABLE IF NOT EXISTS app_hello_items (id text primary key, title text not null, done integer default 0);' };
    const v1 = t.publish({ version: '0.1.5', migrations: m }).app;
    const ev = await t.pm.reconcile([v1]);
    expect(ev[0]).toMatchObject({ kind: 'pending', version: '0.1.5' });
    const { row } = await t.pm.prepareOpen('vn.app.hello');
    expect(row.current_version).toBe('0.1.5');
  });

  test('NO_SAFE_VERSION → revoked, prepareOpen chặn (APP_REVOKED), dữ liệu/thư mục giữ; có lại bản → mở được', async () => {
    const t = setup();
    const app = await installed(t);
    const ev = await t.pm.reconcile([{ ...app, version: null, code: 'NO_SAFE_VERSION', sha256: null, signature: null, key_id: null, package_url: null, sdk_range: null }]);
    expect(ev).toEqual([{ kind: 'revoked', appId: 'vn.app.hello', code: 'NO_SAFE_VERSION' }]);
    await expect(t.pm.prepareOpen('vn.app.hello')).rejects.toMatchObject({ code: 'APP_REVOKED' });
    expect(t.fs.has(DIR + '0.2.0/index.html')).toBe(true);
    const ev2 = await t.pm.reconcile([app]);
    expect(ev2).toEqual([{ kind: 'restored', appId: 'vn.app.hello' }]);
    await expect(t.pm.prepareOpen('vn.app.hello')).resolves.toBeTruthy();
  });

  test('mất mạng giữa lúc tải bản mới → reconcile ném OFFLINE, app cũ không đổi', async () => {
    const t = setup();
    await installed(t);
    const m = { '001_init.sql': 'CREATE TABLE IF NOT EXISTS app_hello_items (id text primary key, title text not null, done integer default 0);' };
    const v3 = t.publish({ version: '0.3.0', migrations: m }).app;
    t.setOffline(true);
    await expect(t.pm.reconcile([v3])).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(t.rows.get('vn.app.hello')?.pending_version).toBeNull();
    expect(t.fs.has(DIR + '.tmp')).toBe(false);
  });

  test('gói bản mới bị sửa → event failed, pending không được đặt', async () => {
    const t = setup();
    await installed(t);
    const m = { '001_init.sql': 'CREATE TABLE IF NOT EXISTS app_hello_items (id text primary key, title text not null, done integer default 0);' };
    const { app, zip } = t.publish({ version: '0.3.0', migrations: m });
    const bad = zip.slice();
    bad[10] ^= 1;
    t.downloads.set(app.package_url as string, bad);
    const ev = await t.pm.reconcile([app]);
    expect(ev[0]).toMatchObject({ kind: 'failed', code: 'PACKAGE_TAMPERED' });
    expect(t.rows.get('vn.app.hello')?.pending_version).toBeNull();
  });
});

describe('AC-4 gỡ', () => {
  test('gỡ xoá mọi thư mục version + dòng + schema; offline thì từ chối và giữ nguyên', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0' });
    await t.pm.install(app);
    t.setOffline(true);
    await expect(t.pm.uninstall('vn.app.hello')).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(t.rows.size).toBe(1);
    expect(t.fs.has(DIR)).toBe(true);
    t.setOffline(false);
    const before = t.schemaChanges;
    await t.pm.uninstall('vn.app.hello');
    expect(t.rows.size).toBe(0);
    expect(t.fs.has(DIR)).toBe(false);
    expect(t.schemaChanges).toBe(before + 1);
  });
  test('cài lại sau khi gỡ thấy lại bảng (dữ liệu nằm ở server/PowerSync, không bị gói động tới)', async () => {
    const t = setup();
    const { app } = t.publish({ version: '0.2.0' });
    await t.pm.install(app);
    await t.pm.uninstall('vn.app.hello');
    const row = await t.pm.install(app);
    expect(row.tables[0].name).toBe('app_hello_items');
  });
});
