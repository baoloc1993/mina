// Kiểu dùng chung của bridge (contract miniapp-sdk-v0, ARCHITECTURE.md §5). THUẦN TS — không import React Native,
// vì mock SDK trên trình duyệt chạy đúng mã này (DECISIONS 2026-10-08).

export type ErrorCode =
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

export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface IntentSend {
  type: string;
  version: string;
}
export interface IntentReceive extends IntentSend {
  schema: unknown;
}

/** manifest.json v0 đủ (ARCHITECTURE.md §5 `miniapp-manifest`). */
export interface Manifest {
  id: string; // reverse-domain, vd "vn.app.hello"
  name: string;
  version: string;
  sdk?: string; // range semver của SDK, vd "^0.1"
  entry: string;
  icon?: string;
  description?: string;
  scopes: string[];
  tables: string[]; // tên ngắn, vd ["items"]
  intents?: { sends?: IntentSend[]; receives?: IntentReceive[] };
  offline?: boolean;
  network?: string[]; // host đúng, không wildcard
}

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}
export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: ErrorCode; message: string; detail?: string };
}

export type SyncState = 'online' | 'syncing' | 'offline' | 'error';
export interface SyncStatus {
  state: SyncState;
  pending: number;
  rejected: number;
  lastSyncedAt: string | null;
}

export interface Stmt {
  sql: string;
  params: unknown[];
}

export interface StoredFile {
  fileId: string;
  uri: string;
  status: 'local' | 'uploaded' | 'cached';
}

export interface ReceiverInfo {
  appId: string;
  type: string;
  version: string;
  schema: unknown;
}

export type IntentMode = 'create' | 'open';
export type IntentOutcome = 'handled' | 'opened' | 'queued';

/**
 * Mọi hiệu ứng (ghi DB, mạng, thông báo, file, UI) chỉ xảy ra qua Host, và chỉ SAU khi guard của bridge xong.
 * Shell bơm Host native; mock bơm Host trình duyệt; bảng kỳ vọng bơm Host giả có bộ đếm (từ chối ⇒ đếm = 0).
 */
export interface Host {
  now(): string;
  newId(): string;
  tenantId(): string | null;
  /** Chỉ đọc do hết ân hạn entitlement — lấy từ module entitlement, KHÔNG từ Date.now() của máy. */
  isReadOnly(): boolean;
  sdkInfo(): { sdkVersion: string; platform: string };
  /** Cấu hình app từ server (`catalog.apps[].config`, bản cache — `{}` khi chưa có). Đọc LÚC GỌI, không bắt lúc dựng Host. */
  appConfig(): Record<string, unknown>;
  /** App đang hiện ở màn hình (foreground). Hộp thoại quyền chỉ mở khi true; `ui.openUrl` từ app nền → APP_SUSPENDED. */
  isForeground(): boolean;
  db: {
    all(sql: string, params: unknown[]): Promise<unknown[]>;
    run(sql: string, params: unknown[]): Promise<void>;
    transaction(stmts: Stmt[]): Promise<void>;
  };
  sync: { status(): SyncStatus };
  auth: { appToken(appId: string): Promise<{ token: string; expires_at: number }> };
  lifecycle: { ready(): void; suspended(): void };
  notify: {
    schedule(n: { id: string; at: number; title: string; body: string; ref: string | null }): Promise<void>;
    cancel(id: string): Promise<void>;
    list(): Promise<{ id: string; at: number; title: string; body: string; ref: string | null }[]>;
  };
  storage: {
    put(f: { name: string; mime: string; base64: string }): Promise<StoredFile>;
    get(fileId: string): Promise<StoredFile>;
    remove(fileId: string): Promise<void>;
  };
  net: {
    /**
     * Host được thêm vào whitelist của app NGOÀI `manifest.network`: `config.network` ∪ grant còn sống của (app × tenant).
     * Đồng bộ và đọc LÚC GỌI (thu hồi có hiệu lực ngay ở bước chuyển hướng kế tiếp).
     */
    extraHosts(): readonly string[];
    /**
     * Hộp thoại hệ thống "Cho phép <app> truy cập <host>?" (C9). Cho phép ⇒ ghi grant rồi trả true; Không ⇒ false (không ghi).
     * Bridge chỉ gọi khi host CHƯA nằm trong whitelist và app đang foreground.
     */
    requestAccess(host: string, reason: string | null): Promise<boolean>;
    /** `isAllowed` PHẢI được gọi cho url ban đầu và cho mọi bước chuyển hướng trước khi gửi request tiếp. */
    fetch(
      req: { url: string; method: string; headers: Record<string, string>; body: string | null; timeoutMs: number },
      isAllowed: (url: string) => boolean,
    ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  };
  ui: {
    toast(text: string): void;
    pickImage(opts: { multiple: boolean }): Promise<{ files: { fileId: string; uri: string; mime: string }[] }>;
    /** Host PHẢI loại tệp sai `mime` hoặc > MAX_FILE_BYTES bằng `INVALID_REQUEST` TRƯỚC khi lưu (không để file mồ côi). */
    pickFile(opts: { mime: string[]; multiple: boolean }): Promise<{ files: { fileId: string; uri: string; mime: string; name: string; size: number }[] }>;
    share(s: { title: string; text: string; url: string | null }): Promise<void>;
    /** Trình duyệt trong app (Custom Tabs / SFSafariViewController). Bridge đã kiểm khuôn `http(s)`; Host chỉ mở. */
    openUrl(url: string): Promise<void>;
  };
  intent: {
    receivers(type: string, version: string | null): ReceiverInfo[];
    deliver(i: {
      type: string;
      version: string;
      payload: unknown;
      mode: IntentMode;
      to: string;
    }): Promise<IntentOutcome>;
  };
}

export interface BridgeContext {
  manifest: Manifest;
  /** Tiền tố bảng server, vd "app_hello" (từ catalog/installations — không tự tính). */
  tablePrefix: string;
  host: Host;
}
