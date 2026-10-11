// Kiểm gói mini app (AC-2): SHA-256 → chữ ký Ed25519 → sdk range → giải nén an toàn → lint manifest + migration.
// Chữ ký = Ed25519 trên 32 byte SHA-256 THÔ của zip; public_key = base64 của 32 byte khoá thô.
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { unzipSync } from 'fflate';
import * as semver from 'semver';
import { KNOWN_SCOPES, SDK_VERSION } from '../bridge/bridge';
import type { Manifest } from '../bridge/types';
import { PackageError, type ColumnKind, type SqlRunner, type TableDef } from './types';

ed.hashes.sha512 = (m: Uint8Array) => sha512(m);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\s=]+$/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buf = 0;
  let bits = 0;
  let n = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new PackageError('PACKAGE_TAMPERED', 'Chữ ký không đúng định dạng base64');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (buf >> bits) & 0xff;
    }
  }
  return out.slice(0, n);
}
export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    s += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    s += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    s += c === undefined ? '=' : B64[c & 63];
  }
  return s;
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export interface SignedMeta {
  sha256: string;
  signature: string;
  key_id: string;
}

/** SHA-256 khớp → khoá nằm trong danh sách tin cậy → chữ ký đúng. Mọi lệch ⇒ không cài gì. */
export function verifyPackage(zip: Uint8Array, meta: SignedMeta, trustedKeys: Record<string, string>): void {
  const digest = sha256(zip);
  if (bytesToHex(digest) !== meta.sha256.toLowerCase()) {
    throw new PackageError('PACKAGE_TAMPERED', 'Gói tải về không khớp mã SHA-256 — không cài');
  }
  const pub = trustedKeys[meta.key_id];
  if (!pub) throw new PackageError('UNTRUSTED_KEY', `Khoá ký "${meta.key_id}" không nằm trong danh sách tin cậy`);
  let ok = false;
  try {
    ok = ed.verify(b64ToBytes(meta.signature), digest, b64ToBytes(pub));
  } catch {
    ok = false;
  }
  if (!ok) throw new PackageError('PACKAGE_TAMPERED', 'Chữ ký gói không hợp lệ — không cài');
}

export function checkSdkRange(range: string | null): void {
  if (!range) throw new PackageError('BAD_MANIFEST', 'Gói thiếu sdk range');
  const valid = semver.validRange(range);
  if (!valid) throw new PackageError('BAD_MANIFEST', `sdk range không hợp lệ: ${range}`);
  if (!semver.satisfies(SDK_VERSION, valid, { includePrerelease: true })) {
    throw new PackageError('SDK_TOO_OLD', `Gói cần SDK ${range}, shell đang là ${SDK_VERSION} — cần cập nhật shell`);
  }
}

const MAX_FILES = 2000;
const MAX_UNZIPPED = 100 * 1024 * 1024;

/** Đường dẫn trong zip phải tương đối, không `..`, không `\`, không ký tự ổ đĩa, không đoạn rỗng/`.`. */
export function safeRelPath(p: string): string | null {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split('/');
  if (parts[parts.length - 1] === '') parts.pop(); // thư mục kết thúc bằng '/'
  if (!parts.length) return null;
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  return parts.join('/');
}

export interface Extracted {
  files: Record<string, Uint8Array>;
}

export function extractZip(zip: Uint8Array): Extracted {
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(zip);
  } catch {
    throw new PackageError('BAD_PACKAGE', 'Không giải nén được gói (zip hỏng)');
  }
  const names = Object.keys(raw);
  if (names.length > MAX_FILES) throw new PackageError('BAD_PACKAGE', 'Gói có quá nhiều file');
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  for (const name of names) {
    const rel = safeRelPath(name);
    if (!rel) throw new PackageError('BAD_PACKAGE', `Đường dẫn không an toàn trong gói: ${name}`);
    if (name.endsWith('/')) continue; // thư mục
    total += raw[name].length;
    if (total > MAX_UNZIPPED) throw new PackageError('BAD_PACKAGE', 'Gói giải nén quá lớn');
    files[rel] = raw[name];
  }
  return { files };
}

const APP_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SHORT_TABLE = /^[a-z][a-z0-9_]*$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** Lint manifest v0 (BAD_MANIFEST). `expect` đối chiếu id/version với catalog. */
export function parseManifest(text: string, files: Record<string, Uint8Array>, expect: { id: string; version: string }): Manifest {
  const bad = (m: string): never => {
    throw new PackageError('BAD_MANIFEST', m);
  };
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text);
  } catch {
    return bad('manifest.json không phải JSON hợp lệ');
  }
  for (const k of ['id', 'name', 'version', 'sdk', 'entry'] as const) {
    if (typeof m[k] !== 'string' || !(m[k] as string).trim()) bad(`manifest thiếu "${k}"`);
  }
  if (!APP_ID.test(m.id as string)) bad('manifest.id không đúng reverse-domain');
  if (m.id !== expect.id) bad(`manifest.id "${String(m.id)}" khác app trong catalog "${expect.id}"`);
  if (m.version !== expect.version) bad(`manifest.version "${String(m.version)}" khác bản trong catalog "${expect.version}"`);
  if (!semver.valid(m.version as string)) bad('manifest.version không phải semver');
  if (!semver.validRange(m.sdk as string)) bad('manifest.sdk không phải range semver');
  const entry = m.entry as string;
  if (!safeRelPath(entry) || !files[entry]) bad(`entry "${entry}" không có trong gói`);
  const scopes = m.scopes ?? [];
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== 'string')) bad('scopes phải là mảng chuỗi');
  for (const s of scopes as string[]) if (!(KNOWN_SCOPES as readonly string[]).includes(s)) bad(`scope lạ: ${s}`);
  const tables = m.tables ?? [];
  if (!Array.isArray(tables) || tables.some((t) => typeof t !== 'string' || !SHORT_TABLE.test(t))) bad('tables phải là mảng tên ngắn chữ thường');
  const network = m.network ?? [];
  if (!Array.isArray(network) || network.some((h) => typeof h !== 'string' || !HOST.test(h.toLowerCase()) || h.includes('*'))) {
    bad('network phải là mảng host đúng, không wildcard');
  }
  if ((network as string[]).length && !(scopes as string[]).includes('net')) bad('có "network" nhưng thiếu scope "net"');
  if ((scopes as string[]).includes('net.user-approved') && !(scopes as string[]).includes('net')) bad('scope "net.user-approved" đòi kèm scope "net"');
  let intents: Manifest['intents'] = { sends: [], receives: [] };
  if (m.intents !== undefined) {
    const i = m.intents as { sends?: unknown; receives?: unknown };
    if (typeof i !== 'object' || i === null || Array.isArray(i)) bad('intents phải là object { sends, receives }');
    const sends = i.sends ?? [];
    const receives = i.receives ?? [];
    if (!Array.isArray(sends) || sends.some((s) => !s || typeof s.type !== 'string' || typeof s.version !== 'string')) bad('intents.sends sai khuôn');
    if (!Array.isArray(receives) || receives.some((s) => !s || typeof s.type !== 'string' || typeof s.version !== 'string' || typeof s.schema !== 'object')) {
      bad('intents.receives sai khuôn');
    }
    if ((sends as unknown[]).length && !(scopes as string[]).includes('intent.send')) bad('có intents.sends nhưng thiếu scope "intent.send"');
    intents = { sends: sends as never, receives: receives as never };
  }
  return {
    id: m.id as string,
    name: m.name as string,
    version: m.version as string,
    sdk: m.sdk as string,
    entry,
    icon: typeof m.icon === 'string' ? m.icon : undefined,
    description: typeof m.description === 'string' ? m.description : undefined,
    scopes: scopes as string[],
    tables: tables as string[],
    intents,
    offline: m.offline === true,
    network: (network as string[]).map((h) => h.toLowerCase()),
  };
}

// ---------- migration SQLite của gói ----------
const IDENT = '[a-z_][a-z0-9_]*';

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const bad = (m: string): never => {
    throw new PackageError('MIGRATION_NOT_ADDITIVE', m);
  };
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) bad('comment /* không đóng');
      i = end + 2;
      cur += ' ';
      continue;
    }
    if (ch === '$' || ch === '"' || ch === '`' || ch === '[') bad(`không cho dùng ký tự "${ch}" trong migration của mini app`);
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) bad("chuỗi ' không đóng");
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Lint fail-closed — chỉ CỘNG THÊM trên bảng thuộc `<table_prefix>_`. Trả các câu lệnh đã tách. */
export function lintMigration(sql: string, prefix: string): string[] {
  const stmts = splitStatements(sql);
  const bad = (m: string): never => {
    throw new PackageError('MIGRATION_NOT_ADDITIVE', m);
  };
  const mustPrefix = (n: string, what = 'bảng') => {
    if (!n.startsWith(`${prefix}_`)) bad(`${what} ${n} không bắt đầu bằng "${prefix}_"`);
  };
  for (const s of stmts) {
    const n = s.replace(/\s+/g, ' ').trim().toLowerCase();
    let m = n.match(new RegExp(`^create table if not exists (${IDENT}) ?\\((.*)\\)$`));
    if (m) {
      mustPrefix(m[1]);
      if (/\b(select|create|like|generated|virtual)\b/.test(m[2])) bad(`bảng ${m[1]} dùng cấu trúc không được phép`);
      continue;
    }
    if (/^create table\b/.test(n)) bad('dùng `CREATE TABLE IF NOT EXISTS <prefix>_… (…)`');
    m = n.match(new RegExp(`^alter table (${IDENT}) add column (${IDENT}) (.+)$`));
    if (m) {
      mustPrefix(m[1]);
      if (/\bnot null\b/.test(m[3]) && !/\bdefault\b/.test(m[3])) bad(`cột ${m[2]} NOT NULL không có DEFAULT`);
      if (/\b(primary key|unique|generated|select)\b/.test(m[3])) bad(`cột ${m[2]} dùng cấu trúc không được phép`);
      continue;
    }
    if (/^alter table\b/.test(n)) bad('ALTER TABLE chỉ cho phép ADD COLUMN');
    m = n.match(new RegExp(`^create (?:unique )?index (?:if not exists )?(${IDENT}) on (${IDENT}) ?\\(.*\\)$`));
    if (m) {
      mustPrefix(m[1], 'tên index');
      mustPrefix(m[2]);
      continue;
    }
    bad(`câu lệnh không được phép: ${s.slice(0, 60)}`);
  }
  return stmts;
}

export function kindOf(type: string): ColumnKind {
  const t = type.toLowerCase();
  if (/int|bool/.test(t)) return 'integer';
  if (/real|floa|doub|numeric|decimal/.test(t)) return 'real';
  return 'text';
}

export const SYSTEM_COLUMNS = ['tenant_id', 'created_at', 'updated_at', 'deleted_at'] as const;

export interface MigrationFile {
  name: string;
  sql: string;
}

/**
 * Chạy TOÀN BỘ migration (tích luỹ) của gói trên một SQLite tạm rồi đọc ra bảng + cột → định nghĩa bảng cho PowerSync.
 * Lỗi SQLite thật (cột trùng, default không hằng…) ⇒ MIGRATION_FAILED; DB thật không bị chạm.
 */
export function deriveTables(migrations: MigrationFile[], prefix: string, tablesInManifest: string[], runner: SqlRunner): TableDef[] {
  try {
    for (const mig of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
      for (const stmt of lintMigration(mig.sql, prefix)) {
        try {
          runner.exec(stmt);
        } catch (e) {
          throw new PackageError('MIGRATION_FAILED', `Migration ${mig.name} lỗi: ${(e as Error).message}`);
        }
      }
    }
    const created = runner.tables();
    for (const t of created) if (!t.startsWith(`${prefix}_`)) throw new PackageError('MIGRATION_NOT_ADDITIVE', `Bảng ${t} nằm ngoài tiền tố ${prefix}_`);
    for (const short of tablesInManifest) {
      if (!created.includes(`${prefix}_${short}`)) {
        throw new PackageError('BAD_MANIFEST', `manifest.tables có "${short}" nhưng migration không tạo bảng ${prefix}_${short}`);
      }
    }
    return created.map((name) => {
      const cols = runner.columns(name).filter((c) => c.name !== 'id');
      const have = new Set(cols.map((c) => c.name));
      const columns = cols.map((c) => ({ name: c.name, kind: kindOf(c.type) }));
      for (const s of SYSTEM_COLUMNS) if (!have.has(s)) columns.push({ name: s, kind: 'text' });
      return { name, columns };
    });
  } finally {
    runner.close();
  }
}

export function readMigrations(files: Record<string, Uint8Array>): MigrationFile[] {
  const dec = new TextDecoder();
  return Object.keys(files)
    .filter((n) => /^migrations\/[^/]+\.sql$/.test(n))
    .sort()
    .map((n) => ({ name: n.slice('migrations/'.length), sql: dec.decode(files[n]) }));
}
