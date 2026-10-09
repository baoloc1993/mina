// Kiểu của Package Manager (CAP-DIST-02/03/04). THUẦN TS — không import React Native để Jest chạy được.
import type { Manifest } from '../bridge/types';

export type PackageErrorCode =
  | 'PACKAGE_TAMPERED'
  | 'UNTRUSTED_KEY'
  | 'SDK_TOO_OLD'
  | 'BAD_PACKAGE'
  | 'BAD_MANIFEST'
  | 'MIGRATION_NOT_ADDITIVE'
  | 'MIGRATION_FAILED'
  | 'UPDATE_FAILED'
  | 'APP_REVOKED'
  | 'NO_SAFE_VERSION'
  | 'PACKAGE_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'APP_NOT_AVAILABLE'
  | 'NO_VERSION'
  | 'APP_NOT_INSTALLED'
  | 'NO_TENANT'
  | 'SESSION_REVOKED'
  | 'OFFLINE'
  | 'NOT_FOUND'
  | 'INTERNAL';

export class PackageError extends Error {
  constructor(
    readonly code: PackageErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** Một app trong phản hồi `GET /functions/v1/catalog` (api-registry + phần thêm của vòng 3). */
export interface CatalogApp {
  id: string;
  name: string;
  table_prefix: string;
  owner_tenant_id: string | null;
  version: string | null;
  sdk_range: string | null;
  package_url: string | null;
  sha256: string | null;
  signature: string | null;
  key_id: string | null;
  status: string | null;
  installed: boolean;
  enabled: boolean;
  position?: number | null;
  code?: 'NO_SAFE_VERSION' | 'PACKAGE_UNAVAILABLE' | string;
  description?: string | null;
  scopes?: string[];
  network?: string[];
  /** Vòng 6: cấu hình app từ server (`app_configs`); vắng = `{}`. Khoá `network` do shell diễn giải. */
  config?: Record<string, unknown>;
}

export interface CatalogEntitlementInfo {
  plan: string;
  max_apps: number | null;
  until: string | null;
  grace_days?: number;
}

export interface CatalogResponse {
  apps: CatalogApp[];
  server_time?: string;
  entitlement?: CatalogEntitlementInfo;
}

export type ColumnKind = 'text' | 'integer' | 'real';
export interface TableDef {
  /** Tên bảng vật lý, vd `app_hello_items`. */
  name: string;
  columns: { name: string; kind: ColumnKind }[];
}

export type AppStatus = 'ok' | 'revoked' | 'update_failed';

/** Một dòng `platform_apps` (local, không sync): "trên máy đang có gì". */
export interface AppRow {
  app_id: string;
  name: string;
  table_prefix: string;
  current_version: string;
  previous_version: string | null;
  pending_version: string | null;
  manifest: Manifest; // của current_version
  pending_manifest: Manifest | null;
  tables: TableDef[]; // của current_version
  sdk_range: string | null;
  installed_at: string;
  status: AppStatus;
  /** Mã/ghi chú lỗi gần nhất (UPDATE_FAILED, APP_REVOKED…). */
  last_error: string | null;
  position: number | null;
  /** 'updated' → banner C8 "đã cập nhật" cho tới khi người dùng đóng. */
  notice: string | null;
  private_to_tenant: boolean;
}

export interface AppRepo {
  list(): Promise<AppRow[]>;
  get(appId: string): Promise<AppRow | null>;
  put(row: AppRow): Promise<void>;
  remove(appId: string): Promise<void>;
}

export interface Fs {
  mkdirp(path: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  readText(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Xoá đệ quy; không lỗi nếu không tồn tại. */
  rm(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  list(path: string): Promise<string[]>;
}

/** SQLite tạm trong bộ nhớ để chạy thử migration (bản sao tạm — không chạm DB thật). */
export interface SqlRunner {
  exec(sql: string): void;
  /** Tên các bảng người dùng (không `sqlite_%`). */
  tables(): string[];
  columns(table: string): { name: string; type: string }[];
  close(): void;
}

export type InstallStep = 'download' | 'verify' | 'extract' | 'migrate' | 'register' | 'done';
