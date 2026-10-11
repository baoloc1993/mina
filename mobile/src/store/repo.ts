// Kho `platform_apps` (local, không sync) trên PowerSync + bảng phụ cục bộ (kv, rejections).
import type { AbstractPowerSyncDatabase } from '@powersync/common';
import type { AppRepo, AppRow } from '../packages/types';

interface Raw {
  id: string;
  name: string;
  table_prefix: string;
  current_version: string;
  previous_version: string | null;
  pending_version: string | null;
  manifest: string;
  pending_manifest: string | null;
  tables_json: string;
  sdk_range: string | null;
  installed_at: string;
  status: string;
  last_error: string | null;
  position: number | null;
  notice: string | null;
  private_to_tenant: number | null;
}

const fromRaw = (r: Raw): AppRow => ({
  app_id: r.id,
  name: r.name,
  table_prefix: r.table_prefix,
  current_version: r.current_version,
  previous_version: r.previous_version,
  pending_version: r.pending_version,
  manifest: JSON.parse(r.manifest),
  pending_manifest: r.pending_manifest ? JSON.parse(r.pending_manifest) : null,
  tables: JSON.parse(r.tables_json),
  sdk_range: r.sdk_range,
  installed_at: r.installed_at,
  status: r.status as AppRow['status'],
  last_error: r.last_error,
  position: r.position,
  notice: r.notice,
  private_to_tenant: !!r.private_to_tenant,
});

export class PowerSyncAppRepo implements AppRepo {
  constructor(private db: AbstractPowerSyncDatabase) {}

  async list(): Promise<AppRow[]> {
    return (await this.db.getAll<Raw>('SELECT * FROM platform_apps')).map(fromRaw);
  }
  async get(appId: string): Promise<AppRow | null> {
    const r = await this.db.getOptional<Raw>('SELECT * FROM platform_apps WHERE id = ?', [appId]);
    return r ? fromRaw(r) : null;
  }
  async put(a: AppRow): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO platform_apps (id, name, table_prefix, current_version, previous_version, pending_version,
        manifest, pending_manifest, tables_json, sdk_range, installed_at, status, last_error, position, notice, private_to_tenant)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.app_id, a.name, a.table_prefix, a.current_version, a.previous_version, a.pending_version,
        JSON.stringify(a.manifest), a.pending_manifest ? JSON.stringify(a.pending_manifest) : null, JSON.stringify(a.tables),
        a.sdk_range, a.installed_at, a.status, a.last_error, a.position, a.notice, a.private_to_tenant ? 1 : 0,
      ],
    );
  }
  async remove(appId: string): Promise<void> {
    await this.db.execute('DELETE FROM platform_apps WHERE id = ?', [appId]);
  }
}

export async function kvGet(db: AbstractPowerSyncDatabase, key: string): Promise<string | null> {
  const r = await db.getOptional<{ value: string }>('SELECT value FROM platform_kv WHERE id = ?', [key]);
  return r?.value ?? null;
}
export async function kvSet(db: AbstractPowerSyncDatabase, key: string, value: string | null): Promise<void> {
  if (value === null) await db.execute('DELETE FROM platform_kv WHERE id = ?', [key]);
  else await db.execute('INSERT OR REPLACE INTO platform_kv (id, value) VALUES (?, ?)', [key, value]);
}
