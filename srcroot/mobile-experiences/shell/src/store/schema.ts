// Schema PowerSync sinh động (ARCHITECTURE.md §6): bảng nền (installations, sync_rejections, core_*) + bảng của các app
// đã cài (suy ra từ migration trong gói) + bảng cục bộ `platform_*` (không sync). Cài/gỡ app ⇒ dựng lại và `updateSchema`.
import { Schema, Table, column } from '@powersync/common';
import type { AppRow, ColumnKind, TableDef } from '../packages/types';

const col = (k: ColumnKind) => (k === 'integer' ? column.integer : k === 'real' ? column.real : column.text);

export function tableFromDef(def: TableDef): Table {
  const cols: Record<string, typeof column.text> = {};
  for (const c of def.columns) cols[c.name] = col(c.kind);
  return new Table(cols);
}

const CORE_TIME = { created_at: column.text, updated_at: column.text, deleted_at: column.text };

export function baseTables(): Record<string, Table> {
  return {
    installations: new Table({
      tenant_id: column.text, app_id: column.text, version: column.text, enabled: column.integer,
      position: column.integer, installed_at: column.text, updated_at: column.text,
    }),
    sync_rejections: new Table({
      tenant_id: column.text, table_name: column.text, row_id: column.text, op: column.text,
      data: column.text, code: column.text, detail: column.text, created_at: column.text,
    }),
    core_tags: new Table({ tenant_id: column.text, name: column.text, color: column.text, ...CORE_TIME }),
    core_contacts: new Table({
      tenant_id: column.text, name: column.text, phone: column.text, email: column.text, note: column.text, ...CORE_TIME,
    }),
    core_files: new Table({
      tenant_id: column.text, app_id: column.text, name: column.text, mime: column.text, size: column.integer,
      storage_path: column.text, uploaded_at: column.text, ...CORE_TIME,
    }),
  };
}

/** Bảng chỉ có trên máy (không sync). `id` do PowerSync tự thêm. */
export function localTables(): Record<string, Table> {
  const local = { localOnly: true };
  return {
    platform_apps: new Table(
      {
        name: column.text, table_prefix: column.text, current_version: column.text, previous_version: column.text,
        pending_version: column.text, manifest: column.text, pending_manifest: column.text, tables_json: column.text,
        sdk_range: column.text, installed_at: column.text, status: column.text, last_error: column.text,
        position: column.integer, notice: column.text, private_to_tenant: column.integer,
      },
      local,
    ),
    platform_file_cache: new Table(
      { local_uri: column.text, status: column.text, size: column.integer, last_used_at: column.integer, app_id: column.text },
      local,
    ),
    platform_notifications: new Table(
      { app_id: column.text, at: column.integer, title: column.text, body: column.text, ref: column.text, os_id: column.text },
      local,
    ),
    platform_intents: new Table(
      { type: column.text, version: column.text, payload: column.text, from_app: column.text, to_app: column.text, created_at: column.text },
      local,
    ),
    platform_rejections: new Table(
      { app_id: column.text, version: column.text, code: column.text, detail: column.text, created_at: column.text },
      local,
    ),
    platform_kv: new Table({ value: column.text }, local),
  };
}

export function buildSchema(apps: Pick<AppRow, 'tables'>[]): Schema {
  const tables: Record<string, Table> = { ...baseTables(), ...localTables() };
  for (const a of apps) for (const t of a.tables) tables[t.name] = tableFromDef(t);
  return new Schema(tables);
}
