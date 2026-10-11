// Adapter native cho Package Manager: file (expo-file-system), tải gói, SQLite tạm (op-sqlite trong bộ nhớ), đồng hồ đơn điệu.
import * as FS from 'expo-file-system/legacy';
import * as Device from 'expo-device';
import { open } from '@op-engineering/op-sqlite';
import { PackageError, type Fs, type SqlRunner } from '../packages/types';
import { b64ToBytes, bytesToB64 } from '../packages/verify';
import type { Clock } from '../entitlement/entitlement';

export const APPS_DIR = `${FS.documentDirectory}apps/`;
export const FILES_DIR = `${FS.documentDirectory}files/`;

const norm = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p);

export const nativeFs: Fs = {
  async mkdirp(path) {
    await FS.makeDirectoryAsync(path, { intermediates: true }).catch(async (e) => {
      if (!(await FS.getInfoAsync(path)).exists) throw e;
    });
  },
  async writeBytes(path, bytes) {
    await FS.writeAsStringAsync(path, bytesToB64(bytes), { encoding: FS.EncodingType.Base64 });
  },
  readText: (path) => FS.readAsStringAsync(path),
  async exists(path) {
    return (await FS.getInfoAsync(path)).exists;
  },
  async rm(path) {
    await FS.deleteAsync(path, { idempotent: true });
  },
  async rename(from, to) {
    await FS.moveAsync({ from: norm(from), to: norm(to) });
  },
  async list(path) {
    return FS.readDirectoryAsync(path);
  },
};

/** Tải gói về RAM. Mất mạng / máy chủ không với tới ⇒ OFFLINE. */
export async function downloadBytes(url: string): Promise<Uint8Array> {
  const tmp = `${FS.cacheDirectory}pkg-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`;
  try {
    const r = await FS.downloadAsync(url, tmp);
    if (r.status !== 200) throw new PackageError('PACKAGE_UNAVAILABLE', `Tải gói thất bại (HTTP ${r.status})`);
    return b64ToBytes(await FS.readAsStringAsync(tmp, { encoding: FS.EncodingType.Base64 }));
  } catch (e) {
    if (e instanceof PackageError) throw e;
    throw new PackageError('OFFLINE', 'Không tải được gói — kiểm tra mạng');
  } finally {
    await FS.deleteAsync(tmp, { idempotent: true }).catch(() => undefined);
  }
}

/** SQLite tạm trong bộ nhớ để chạy thử migration — không chạm DB thật. */
export function newScratch(): SqlRunner {
  const db = open({ name: `scratch-${Date.now()}-${Math.random().toString(36).slice(2)}`, location: ':memory:' });
  return {
    exec: (sql) => void db.executeSync(sql),
    tables: () =>
      db
        .executeSync("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .rows.map((r) => String(r.name)),
    columns: (t) => db.executeSync(`PRAGMA table_info(${t})`).rows.map((r) => ({ name: String(r.name), type: String(r.type ?? '') })),
    close: () => db.close(),
  };
}

/** Đồng hồ đơn điệu = uptime hệ thống (sống qua lần mở lại app, reset khi khởi động lại máy). */
export async function createClock(): Promise<Clock> {
  const uptime = await Device.getUptimeAsync().catch(() => 0);
  const perf0 = performance.now();
  return {
    // uptime lúc khởi động app + thời gian trôi đo bằng performance.now (đơn điệu, không bị chỉnh đồng hồ)
    monotonicMs: () => uptime + (performance.now() - perf0),
    wallMs: () => Date.now(),
  };
}

export function uuid(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Crypto = require('expo-crypto') as typeof import('expo-crypto');
  return Crypto.randomUUID();
}
