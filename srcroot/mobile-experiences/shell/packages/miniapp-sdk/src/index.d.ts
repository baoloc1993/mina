// Kiểu TypeScript cho `window.miniapp` — SDK v0 (@platform/miniapp-sdk 0.1.0, ARCHITECTURE.md §5 `miniapp-sdk-v0`).
// Dùng: `/// <reference types="@platform/miniapp-sdk/types" />` hoặc `import type {} from '@platform/miniapp-sdk/types'`.

export type MiniappErrorCode =
  | 'INVALID_REQUEST'
  | 'SCOPE_DENIED'
  | 'SQL_REJECTED'
  | 'OFFLINE'
  | 'INTERNAL'
  | 'READ_ONLY'
  | 'NOT_FOUND'
  | 'INTENT_REJECTED'
  | 'INTENT_NO_HANDLER'
  | 'NET_BLOCKED'
  | 'NET_ERROR'
  | 'PERMISSION_DENIED'
  | 'APP_SUSPENDED';

/** Lỗi mọi Promise của SDK từ chối bằng. */
export interface MiniappError extends Error {
  code: MiniappErrorCode;
  /** INTENT_REJECTED: đường dẫn schema sai; NET_BLOCKED: host bị chặn. */
  detail?: string;
}

export type Scope =
  | 'db'
  | 'db.own'
  | 'core.tags:read'
  | 'core.tags:write'
  | 'core.contacts:read'
  | 'core.contacts:write'
  | 'core.files:read'
  | 'core.files:write'
  | 'intent.send'
  | 'notify.local'
  | 'storage.files'
  | 'net'
  | 'ui.native'
  | 'auth.token';

export interface IntentSend {
  type: string;
  version: string;
}
export interface IntentReceive extends IntentSend {
  /** JSON Schema draft-07 của payload. */
  schema: Record<string, unknown>;
}

/** `manifest.json` v0. */
export interface Manifest {
  /** Reverse-domain, ví dụ "vn.app.hello". */
  id: string;
  name: string;
  /** semver, ví dụ "0.2.0". */
  version: string;
  /** Range semver của SDK, ví dụ "^0.1". */
  sdk: string;
  entry: string;
  /** PNG 256×256. */
  icon?: string;
  description?: string;
  scopes: Scope[];
  /** Tên ngắn, ví dụ ["items"]. */
  tables: string[];
  intents?: { sends?: IntentSend[]; receives?: IntentReceive[] };
  offline?: boolean;
  /** Host đúng, không wildcard. */
  network?: string[];
}

export type Primitive = string | number | null;
export type SqlParams = Primitive[];
export type Row = Record<string, unknown>;

export interface AppInfo {
  appId: string;
  version: string;
  sdkVersion: string;
  platform: string;
  readOnly: boolean;
}

export interface SyncStatus {
  state: 'online' | 'syncing' | 'offline' | 'error';
  pending: number;
  rejected: number;
  lastSyncedAt: string | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
}
export interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  note: string | null;
}
export interface CoreFile {
  id: string;
  app_id: string | null;
  name: string;
  mime: string;
  size: number;
  uploaded_at: string | null;
}

export interface IntentEvent {
  type: string;
  version?: string;
  payload: unknown;
  ref?: string | null;
  mode?: 'create' | 'open';
}

export interface StoredFile {
  fileId: string;
  uri: string;
  status: 'local' | 'uploaded' | 'cached';
}

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MiniappSdk {
  /** Báo shell: app đã dựng xong (tắt splash). */
  ready(): Promise<true>;
  info(): Promise<AppInfo>;
  /**
   * Đăng ký sự kiện từ shell; trả hàm huỷ đăng ký.
   * `suspend`: có tối đa 450 ms mỗi handler để lưu trạng thái (trả Promise nếu bất đồng bộ); SDK tự báo `sdk.suspended`.
   * `intent`: intent tới trước khi bạn đăng ký được giữ lại (tối đa 20) và giao khi đăng ký.
   */
  on(event: 'suspend' | 'resume', fn: () => void | Promise<void>): () => void;
  on(event: 'intent', fn: (i: IntentEvent) => void): () => void;
  on(event: 'sync', fn: (s: SyncStatus) => void): () => void;
}

export interface Miniapp {
  sdk: MiniappSdk;
  db: {
    /** Chỉ SELECT. Bảng viết tên ngắn; dòng `deleted_at` khác null tự bị lọc, trừ khi `includeDeleted`. */
    query<T = Row>(sql: string, params?: SqlParams, opts?: { includeDeleted?: boolean }): Promise<T[]>;
    /** INSERT / UPDATE / DELETE (DELETE là xoá mềm). */
    execute(sql: string, params?: SqlParams): Promise<true>;
    /** Tất cả cùng thành công hoặc cùng không (tối đa 100 câu). */
    transaction(statements: { sql: string; params?: SqlParams }[]): Promise<true>;
  };
  core: {
    tags: {
      list(): Promise<Tag[]>;
      create(tag: { name: string; color?: string }): Promise<Tag>;
    };
    contacts: {
      search(q: string): Promise<Contact[]>;
      create(c: { name: string; phone?: string; email?: string; note?: string }): Promise<Contact>;
    };
    files: {
      get(id: string): Promise<CoreFile>;
      list(opts?: { appId?: string }): Promise<CoreFile[]>;
    };
  };
  intent: {
    /** `create` giao cho app nhận (ghi dữ liệu ở đó); `open` chuyển sang app nhận rồi giao. */
    send(
      type: string,
      payload: unknown,
      opts?: { mode?: 'create' | 'open'; version?: string },
    ): Promise<{ status: 'handled' | 'opened' | 'queued' }>;
  };
  notify: {
    /** `at`: số epoch ms, Date hoặc chuỗi ISO. `ref` không phải chuỗi sẽ được JSON.stringify. */
    schedule(n: { id: string; at: number | Date | string; title: string; body?: string; ref?: unknown }): Promise<true>;
    cancel(id: string): Promise<true>;
    list(): Promise<{ id: string; at: number; title: string; body: string; ref: string | null }[]>;
  };
  storage: {
    put(f: { name: string; mime: string; base64: string }): Promise<StoredFile>;
    get(fileId: string): Promise<StoredFile>;
    remove(fileId: string): Promise<true>;
  };
  net: {
    fetch(
      url: string,
      opts?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
    ): Promise<NetResponse>;
  };
  ui: {
    toast(text: string): Promise<true>;
    pickImage(opts?: { multiple?: boolean }): Promise<{ files: { fileId: string; uri: string; mime: string }[] }>;
    share(s: { title?: string; text?: string; url?: string }): Promise<true>;
  };
  sync: { status(): Promise<SyncStatus> };
  auth: { getAppToken(): Promise<{ token: string; expires_at: number }> };
  /** Gọi method tuỳ ý theo tên (để thử ca phá). Method không có trong SDK v0 → SCOPE_DENIED. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    readonly miniapp: Miniapp;
  }
}
