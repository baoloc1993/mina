// Driver SQLite WASM cho trình duyệt. DB nằm trong bộ nhớ; sau mỗi lần ghi, ảnh chụp DB (serialize) được lưu vào
// IndexedDB theo khoá `<appId>` để tải lại trang không mất dữ liệu. Không có IndexedDB → chỉ dùng bộ nhớ.
// (OPFS cần Worker + SharedArrayBuffer/COOP-COEP — bỏ để mock chạy được bằng một lệnh; xem DECISIONS.)
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqlDriver } from './db';

const IDB_NAME = 'mina-mock-sdk';
const IDB_STORE = 'db';

function idb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function idbGet(key: string): Promise<Uint8Array | null> {
  try {
    const d = await idb();
    return await new Promise((ok) => {
      const q = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
      q.onsuccess = () => ok((q.result as Uint8Array) ?? null);
      q.onerror = () => ok(null);
    });
  } catch {
    return null;
  }
}
async function idbPut(key: string, bytes: Uint8Array | null): Promise<void> {
  try {
    const d = await idb();
    await new Promise<void>((ok) => {
      const s = d.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE);
      const q = bytes ? s.put(bytes, key) : s.delete(key);
      q.onsuccess = () => ok();
      q.onerror = () => ok();
    });
  } catch {
    /* không có IndexedDB */
  }
}

export interface WasmDb extends SqlDriver {
  /** Lưu ảnh chụp DB (gọi sau khi ghi; tự gom 300 ms). */
  persist(): void;
  /** Xoá sạch DB đã lưu (nút "Đặt lại DB"). */
  wipe(): Promise<void>;
  restored: boolean;
}

export async function openWasmDb(key: string): Promise<WasmDb> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  let restored = false;

  const saved = await idbGet(key);
  if (saved && saved.byteLength) {
    try {
      const p = sqlite3.wasm.allocFromTypedArray(saved);
      const rc = sqlite3.capi.sqlite3_deserialize(
        db.pointer!,
        'main',
        p,
        saved.byteLength,
        saved.byteLength,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
      );
      restored = rc === 0;
    } catch {
      restored = false;
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const driver: WasmDb = {
    restored,
    exec: (sql) => void db.exec(sql),
    all: (sql, params) =>
      db.exec({ sql, bind: params as never, rowMode: 'object', returnValue: 'resultRows' }) as unknown as Record<string, unknown>[],
    run: (sql, params) => void db.exec({ sql, bind: params as never }),
    persist: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          void idbPut(key, sqlite3.capi.sqlite3_js_db_export(db.pointer!));
        } catch {
          /* bỏ qua */
        }
      }, 300);
    },
    wipe: async () => {
      if (timer) clearTimeout(timer);
      await idbPut(key, null);
    },
  };
  return driver;
}
