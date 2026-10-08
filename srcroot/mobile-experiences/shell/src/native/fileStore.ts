// File lớn qua Storage (CAP-SYNC-05, AC-11): ghi local ngay (status `local`) + dòng metadata `core_files`; upload khi có mạng;
// máy khác thấy metadata qua sync, `get` tải về khi dùng lần đầu rồi cache; dọn LRU nhưng KHÔNG BAO GIỜ dọn file chưa upload.
import * as FS from 'expo-file-system/legacy';
import type { AbstractPowerSyncDatabase } from '@powersync/common';
import { BridgeError, type StoredFile } from '../bridge/types';
import { supabase } from '../auth/supabase';
import { b64ToBytes } from '../packages/verify';
import { FILES_DIR, uuid } from './adapters';
import { DEFAULT_MAX_BYTES, pickEvictions } from './evict';

export interface CacheRow {
  id: string;
  local_uri: string;
  status: 'local' | 'uploading' | 'uploaded' | 'cached';
  size: number;
  last_used_at: number;
  app_id: string;
}

const extOf = (name: string) => {
  const m = name.match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? `.${m[1].toLowerCase()}` : '';
};

export class FileStore {
  private uploading = false;
  constructor(
    private db: AbstractPowerSyncDatabase,
    private tenantId: () => string | null,
    private maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  async put(appId: string, f: { name: string; mime: string; base64: string }): Promise<StoredFile> {
    const tenant = this.tenantId();
    if (!tenant) throw new BridgeError('INTERNAL', 'Chưa có phiên đăng nhập');
    const fileId = uuid();
    await FS.makeDirectoryAsync(FILES_DIR, { intermediates: true }).catch(() => undefined);
    const uri = `${FILES_DIR}${fileId}${extOf(f.name)}`;
    await FS.writeAsStringAsync(uri, f.base64, { encoding: FS.EncodingType.Base64 });
    const size = Math.floor((f.base64.length * 3) / 4);
    const now = new Date().toISOString();
    await this.db.writeTransaction(async (tx) => {
      await tx.execute('INSERT INTO platform_file_cache (id, local_uri, status, size, last_used_at, app_id) VALUES (?, ?, ?, ?, ?, ?)', [fileId, uri, 'local', size, Date.now(), appId]);
      await tx.execute(
        'INSERT INTO core_files (id, tenant_id, app_id, name, mime, size, storage_path, uploaded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
        [fileId, tenant, appId, f.name, f.mime, size, `${tenant}/${fileId}`, now, now],
      );
    });
    void this.uploadPending().catch(() => undefined);
    return { fileId, uri, status: 'local' };
  }

  /** `allowOtherApps`: app có scope core.files:read được lấy file của app khác trong cùng tenant. */
  async get(appId: string, fileId: string, allowOtherApps: boolean): Promise<StoredFile> {
    const meta = await this.db.getOptional<{ app_id: string; storage_path: string; uploaded_at: string | null; name: string }>(
      'SELECT app_id, storage_path, uploaded_at, name FROM core_files WHERE id = ? AND deleted_at IS NULL',
      [fileId],
    );
    if (!meta || (meta.app_id !== appId && !allowOtherApps)) throw new BridgeError('NOT_FOUND', 'Không có file này');
    const cache = await this.db.getOptional<CacheRow>('SELECT * FROM platform_file_cache WHERE id = ?', [fileId]);
    if (cache && (await FS.getInfoAsync(cache.local_uri)).exists) {
      await this.db.execute('UPDATE platform_file_cache SET last_used_at = ? WHERE id = ?', [Date.now(), fileId]);
      return { fileId, uri: cache.local_uri, status: cache.status === 'cached' ? 'cached' : cache.status === 'uploaded' ? 'uploaded' : 'local' };
    }
    if (!meta.uploaded_at) throw new BridgeError('NOT_FOUND', 'File chưa được tải lên từ máy gốc');
    const signed = await supabase.storage.from('files').createSignedUrl(meta.storage_path, 900);
    if (signed.error || !signed.data?.signedUrl) throw new BridgeError('OFFLINE', 'Cần mạng để tải file về lần đầu');
    await FS.makeDirectoryAsync(FILES_DIR, { intermediates: true }).catch(() => undefined);
    const uri = `${FILES_DIR}${fileId}${extOf(meta.name)}`;
    const dl = await FS.downloadAsync(signed.data.signedUrl, uri).catch(() => null);
    if (!dl || dl.status !== 200) {
      await FS.deleteAsync(uri, { idempotent: true });
      throw new BridgeError('OFFLINE', 'Không tải được file — kiểm tra mạng');
    }
    const info = await FS.getInfoAsync(uri);
    await this.db.execute('INSERT OR REPLACE INTO platform_file_cache (id, local_uri, status, size, last_used_at, app_id) VALUES (?, ?, ?, ?, ?, ?)', [
      fileId, uri, 'cached', info.exists ? info.size : 0, Date.now(), meta.app_id,
    ]);
    void this.trim().catch(() => undefined);
    return { fileId, uri, status: 'cached' };
  }

  async remove(appId: string, fileId: string): Promise<void> {
    const meta = await this.db.getOptional<{ app_id: string }>('SELECT app_id FROM core_files WHERE id = ? AND deleted_at IS NULL', [fileId]);
    if (!meta || meta.app_id !== appId) throw new BridgeError('NOT_FOUND', 'Không có file này');
    const now = new Date().toISOString();
    await this.db.execute('UPDATE core_files SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, fileId]);
    const cache = await this.db.getOptional<CacheRow>('SELECT * FROM platform_file_cache WHERE id = ?', [fileId]);
    if (cache) {
      await FS.deleteAsync(cache.local_uri, { idempotent: true });
      await this.db.execute('DELETE FROM platform_file_cache WHERE id = ?', [fileId]);
    }
  }

  /** Upload tuần tự các file `local` theo thứ tự tạo; lỗi mạng ⇒ để nguyên `local`, thử lại lần sau. */
  async uploadPending(): Promise<number> {
    if (this.uploading) return 0;
    this.uploading = true;
    let done = 0;
    try {
      const rows = await this.db.getAll<CacheRow & { storage_path: string; mime: string }>(
        `SELECT c.*, f.storage_path, f.mime FROM platform_file_cache c JOIN core_files f ON f.id = c.id
          WHERE c.status IN ('local','uploading') ORDER BY f.created_at`,
      );
      for (const r of rows) {
        await this.db.execute("UPDATE platform_file_cache SET status = 'uploading' WHERE id = ?", [r.id]);
        try {
          const b64 = await FS.readAsStringAsync(r.local_uri, { encoding: FS.EncodingType.Base64 });
          const up = await supabase.storage.from('files').upload(r.storage_path, b64ToBytes(b64), { contentType: r.mime, upsert: true });
          if (up.error) throw up.error;
          const now = new Date().toISOString();
          await this.db.execute('UPDATE core_files SET uploaded_at = ?, updated_at = ? WHERE id = ?', [now, now, r.id]);
          await this.db.execute("UPDATE platform_file_cache SET status = 'uploaded' WHERE id = ?", [r.id]);
          done++;
        } catch {
          await this.db.execute("UPDATE platform_file_cache SET status = 'local' WHERE id = ?", [r.id]);
          break; // mất mạng — dừng, lần sau thử lại từ đầu file này
        }
      }
    } finally {
      this.uploading = false;
    }
    if (done) void this.trim().catch(() => undefined);
    return done;
  }

  async trim(): Promise<void> {
    const rows = await this.db.getAll<CacheRow>('SELECT * FROM platform_file_cache');
    for (const id of pickEvictions(rows, this.maxBytes)) {
      const r = rows.find((x) => x.id === id) as CacheRow;
      await FS.deleteAsync(r.local_uri, { idempotent: true });
      await this.db.execute('DELETE FROM platform_file_cache WHERE id = ?', [id]);
    }
  }

  async pendingCount(): Promise<number> {
    const r = await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM platform_file_cache WHERE status IN ('local','uploading')");
    return r.n;
  }
}
