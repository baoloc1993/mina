// Package Manager (CAP-DIST-02/03/04): cài, cập nhật ngầm, rollback, gỡ. THUẦN TS — mọi I/O đi qua `PmDeps`
// (file, tải, RPC, SQLite tạm, kho `platform_apps`) nên Jest chạy được bằng đồ giả; shell bơm bản native.
//
// Thư mục: <apps>/<app_id>/<version>/ — giữ đúng 2 bản (đang chạy + bản trước). Bản mới tải vào thư mục version mới,
// KHÔNG thay app đang mở; hoán đổi ở lần mở sau (`prepareOpen`). Hoán đổi lỗi ⇒ UPDATE_FAILED, bản cũ vẫn chạy.
import * as semver from 'semver';
import {
  checkSdkRange,
  deriveTables,
  extractZip,
  parseManifest,
  readMigrations,
  verifyPackage,
  type MigrationFile,
} from './verify';
import {
  PackageError,
  type AppRepo,
  type AppRow,
  type CatalogApp,
  type Fs,
  type InstallStep,
  type SqlRunner,
} from './types';
import type { Manifest } from '../bridge/types';

export interface PmDeps {
  /** Thư mục gốc chứa các app, kết thúc bằng '/'. */
  appsDir: string;
  fs: Fs;
  /** Tải gói về RAM. Mất mạng ⇒ ném PackageError('OFFLINE'). */
  download(url: string): Promise<Uint8Array>;
  api: {
    installApp(appId: string): Promise<void>;
    uninstallApp(appId: string): Promise<void>;
  };
  trustedKeys(): Promise<Record<string, string>>;
  newScratch(): SqlRunner;
  repo: AppRepo;
  /** Dựng lại schema PowerSync từ `repo.list()` sau khi tập bảng đổi. */
  onSchemaChanged(): Promise<void>;
  now(): string;
  rand(): string;
  /** Ghi một dòng vào hàng đợi lỗi cục bộ (S6) — vd UPDATE_FAILED. */
  recordFailure(appId: string, version: string, code: string, detail: string): Promise<void>;
}

export type StepFn = (step: InstallStep) => void;

export type UpdateEvent =
  | { kind: 'pending'; appId: string; version: string }
  | { kind: 'revoked'; appId: string; code: string }
  | { kind: 'restored'; appId: string }
  | { kind: 'failed'; appId: string; version: string; code: string };

interface Staged {
  dir: string; // thư mục version đích (chưa đổi tên)
  tmp: string;
  manifest: Manifest;
  files: Record<string, Uint8Array>;
}

export class PackageManager {
  constructor(private d: PmDeps) {}

  appDir(appId: string): string {
    return `${this.d.appsDir}${appId}/`;
  }
  versionDir(appId: string, version: string): string {
    return `${this.appDir(appId)}${version}/`;
  }

  /** Tải + kiểm + giải nén vào thư mục tạm (chưa chạy migration, chưa đụng thư mục version). */
  private async stage(app: CatalogApp, step: StepFn): Promise<Staged> {
    if (!app.version || app.code === 'NO_SAFE_VERSION') {
      throw new PackageError('NO_SAFE_VERSION', 'App không còn bản an toàn để cài');
    }
    if (!app.package_url || !app.sha256 || !app.signature || !app.key_id || !app.sdk_range) {
      throw new PackageError('PACKAGE_UNAVAILABLE', 'Máy chủ chưa có gói của app này');
    }
    const tmp = `${this.appDir(app.id)}.tmp-${app.version}-${this.d.rand()}/`;
    step('download');
    const bytes = await this.d.download(app.package_url);
    step('verify');
    verifyPackage(bytes, { sha256: app.sha256, signature: app.signature, key_id: app.key_id }, await this.d.trustedKeys());
    checkSdkRange(app.sdk_range);
    step('extract');
    const { files } = extractZip(bytes);
    if (!files['manifest.json']) throw new PackageError('BAD_PACKAGE', 'Gói thiếu manifest.json');
    const manifest = parseManifest(new TextDecoder().decode(files['manifest.json']), files, { id: app.id, version: app.version });
    checkSdkRange(manifest.sdk ?? null);
    try {
      await this.d.fs.rm(tmp);
      for (const [name, data] of Object.entries(files)) {
        const slash = name.lastIndexOf('/');
        if (slash > 0) await this.d.fs.mkdirp(tmp + name.slice(0, slash));
        else await this.d.fs.mkdirp(tmp);
        await this.d.fs.writeBytes(tmp + name, data);
      }
    } catch (e) {
      await this.d.fs.rm(tmp);
      throw e;
    }
    return { dir: this.versionDir(app.id, app.version), tmp, manifest, files };
  }

  private async commitDir(s: Staged): Promise<void> {
    await this.d.fs.rm(s.dir);
    await this.d.fs.rename(s.tmp, s.dir);
  }

  /** Cài lần đầu từ catalog (AC-2). Lỗi ở bước nào ⇒ không còn vết trên máy. */
  async install(app: CatalogApp, step: StepFn = () => undefined): Promise<AppRow> {
    const existing = await this.d.repo.get(app.id);
    if (existing && existing.status === 'ok' && existing.current_version === app.version) return existing;
    const s = await this.stage(app, step);
    try {
      step('migrate');
      const tables = deriveTables(readMigrations(s.files), app.table_prefix, s.manifest.tables, this.d.newScratch());
      await this.commitDir(s);
      step('register');
      try {
        await this.d.api.installApp(app.id);
      } catch (e) {
        await this.d.fs.rm(s.dir);
        throw e;
      }
      const row: AppRow = {
        app_id: app.id,
        name: s.manifest.name,
        table_prefix: app.table_prefix,
        current_version: s.manifest.version,
        previous_version: null,
        pending_version: null,
        manifest: s.manifest,
        pending_manifest: null,
        tables,
        sdk_range: app.sdk_range,
        installed_at: this.d.now(),
        status: 'ok',
        last_error: null,
        position: app.position ?? null,
        notice: null,
        private_to_tenant: app.owner_tenant_id !== null,
      };
      await this.d.repo.put(row);
      await this.d.onSchemaChanged();
      step('done');
      return row;
    } catch (e) {
      await this.d.fs.rm(s.tmp);
      throw e;
    }
  }

  /**
   * So catalog với máy (AC-3): version cao hơn ⇒ tải ngầm thành pending; version thấp hơn / NO_SAFE_VERSION ⇒ bản đang chạy
   * bị thu hồi. KHÔNG thay thứ đang chạy — hoán đổi ở `prepareOpen`.
   */
  async reconcile(catalog: CatalogApp[]): Promise<UpdateEvent[]> {
    const events: UpdateEvent[] = [];
    const byId = new Map(catalog.map((c) => [c.id, c]));
    for (const row of await this.d.repo.list()) {
      const c = byId.get(row.app_id);
      if (!c) continue;
      try {
        if (!c.version || c.code === 'NO_SAFE_VERSION') {
          if (row.status !== 'revoked') {
            await this.d.repo.put({ ...row, status: 'revoked', last_error: 'APP_REVOKED' });
            events.push({ kind: 'revoked', appId: row.app_id, code: 'NO_SAFE_VERSION' });
          }
          continue;
        }
        if (c.version === row.current_version) {
          if (row.status === 'revoked') {
            await this.d.repo.put({ ...row, status: 'ok', last_error: null });
            events.push({ kind: 'restored', appId: row.app_id });
          }
          continue;
        }
        if (row.pending_version === c.version) continue; // đã tải rồi
        if (semver.gt(c.version, row.current_version)) {
          events.push(await this.stageUpdate(row, c, false));
        } else {
          // Bản đang chạy bị thu hồi (catalog trả version thấp hơn).
          if (row.previous_version === c.version) {
            const prev = await this.readManifestOf(row.app_id, c.version);
            await this.d.repo.put({ ...row, pending_version: c.version, pending_manifest: prev, last_error: 'APP_REVOKED' });
            events.push({ kind: 'pending', appId: row.app_id, version: c.version });
          } else {
            events.push(await this.stageUpdate(row, c, true));
          }
        }
      } catch (e) {
        const code = e instanceof PackageError ? e.code : 'INTERNAL';
        if (code === 'OFFLINE') throw e; // mất mạng giữa chừng: dừng cả vòng, thử lại lần sau
        events.push({ kind: 'failed', appId: row.app_id, version: c.version ?? '', code });
      }
    }
    return events;
  }

  private async readManifestOf(appId: string, version: string): Promise<Manifest | null> {
    try {
      return JSON.parse(await this.d.fs.readText(`${this.versionDir(appId, version)}manifest.json`)) as Manifest;
    } catch {
      return null;
    }
  }

  private async stageUpdate(row: AppRow, c: CatalogApp, downgrade: boolean): Promise<UpdateEvent> {
    const s = await this.stage(c, () => undefined);
    try {
      // Đã có thư mục version này (vd bản trước còn nằm đó)? Thay bằng bản vừa tải & kiểm.
      if (row.pending_version && row.pending_version !== c.version) await this.d.fs.rm(this.versionDir(row.app_id, row.pending_version));
      await this.commitDir(s);
    } catch (e) {
      await this.d.fs.rm(s.tmp);
      throw e;
    }
    await this.d.repo.put({
      ...row,
      pending_version: c.version,
      pending_manifest: s.manifest,
      last_error: downgrade ? 'APP_REVOKED' : row.last_error,
    });
    return { kind: 'pending', appId: row.app_id, version: c.version as string };
  }

  /**
   * Mở app: hoán đổi bản chờ (nếu có) rồi trả thư mục để nạp. Bản đang chạy bị thu hồi mà không có bản an toàn ⇒ APP_REVOKED.
   */
  async prepareOpen(appId: string): Promise<{ row: AppRow; dir: string }> {
    let row = await this.d.repo.get(appId);
    if (!row) throw new PackageError('NOT_FOUND', 'App chưa được cài trên máy này');
    if (row.pending_version) {
      await this.swap(row);
      row = (await this.d.repo.get(appId)) as AppRow;
    }
    if (row.status === 'revoked') {
      throw new PackageError('APP_REVOKED', 'Bản này đã bị thu hồi, cần mạng để cập nhật');
    }
    return { row, dir: this.versionDir(appId, row.current_version) };
  }

  /** Chạy migration của bản chờ trên SQLite tạm; đạt ⇒ đổi current; lỗi ⇒ UPDATE_FAILED, giữ bản cũ. */
  private async swap(row: AppRow): Promise<void> {
    const pending = row.pending_version as string;
    const dir = this.versionDir(row.app_id, pending);
    try {
      const manifest =
        row.pending_manifest ?? (JSON.parse(await this.d.fs.readText(`${dir}manifest.json`)) as Manifest);
      const migrations: MigrationFile[] = [];
      const migDir = `${dir}migrations/`;
      if (await this.d.fs.exists(migDir)) {
        for (const n of (await this.d.fs.list(migDir)).filter((x) => x.endsWith('.sql')).sort()) {
          migrations.push({ name: n, sql: await this.d.fs.readText(migDir + n) });
        }
      }
      const tables = deriveTables(migrations, row.table_prefix, manifest.tables, this.d.newScratch());
      const rollback = semver.lt(pending, row.current_version);
      // Chỉ giữ 2 bản: bản trước nữa bị xoá; bản bị thu hồi (rollback) cũng xoá, không giữ làm "bản trước".
      if (row.previous_version && row.previous_version !== pending) await this.d.fs.rm(this.versionDir(row.app_id, row.previous_version));
      if (rollback) await this.d.fs.rm(this.versionDir(row.app_id, row.current_version));
      await this.d.repo.put({
        ...row,
        previous_version: rollback ? null : row.current_version,
        current_version: pending,
        manifest,
        tables,
        pending_version: null,
        pending_manifest: null,
        status: 'ok',
        last_error: null,
        notice: rollback ? null : 'updated',
        name: manifest.name,
      });
      await this.d.onSchemaChanged();
    } catch (e) {
      const code = e instanceof PackageError ? e.code : 'INTERNAL';
      await this.d.fs.rm(dir);
      await this.d.repo.put({
        ...row,
        pending_version: null,
        pending_manifest: null,
        status: row.status === 'revoked' ? 'revoked' : 'update_failed',
        last_error: 'UPDATE_FAILED',
      });
      await this.d.recordFailure(row.app_id, pending, 'UPDATE_FAILED', `${code}: ${(e as Error).message}`);
    }
  }

  /** Gỡ khỏi máy này + báo server (AC-4). Offline ⇒ OFFLINE từ api, không gỡ nửa vời. */
  async uninstall(appId: string): Promise<void> {
    const row = await this.d.repo.get(appId);
    if (!row) throw new PackageError('NOT_FOUND', 'App chưa được cài trên máy này');
    await this.d.api.uninstallApp(appId);
    await this.removeLocal(appId);
  }

  /** Xoá dấu vết cục bộ (dùng khi gỡ ở máy khác, không gọi RPC). Dữ liệu server giữ nguyên. */
  async removeLocal(appId: string): Promise<void> {
    await this.d.fs.rm(this.appDir(appId));
    await this.d.repo.remove(appId);
    await this.d.onSchemaChanged();
  }

  async dismissNotice(appId: string): Promise<void> {
    const row = await this.d.repo.get(appId);
    if (row && row.notice) await this.d.repo.put({ ...row, notice: null });
  }
}
