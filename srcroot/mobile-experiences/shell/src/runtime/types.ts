// Hợp đồng giữa Runtime (logic: auth, sync, package manager, vòng đời mini app, entitlement) và UI (màn S1–S9, component C1–C14).
// UI chỉ đọc `RuntimeState` và gọi phương thức của `Runtime` — không tự chạm DB, mạng, file. Màn hình bám `context/PROTOTYPE.md`
// và `prototype/shell/index.html`; hình thức bám `context/DESIGN-SYSTEM.md` (token qua `@platform/miniapp-sdk/tokens`).
import type { EntitlementState } from '../entitlement/entitlement';
import type { AppRow, CatalogApp, InstallStep } from '../packages/types';
import type { SyncStatus } from '../bridge/types';
import type { NetGrantItem } from './netGrants';

export type { AppRow, CatalogApp, InstallStep, SyncStatus, EntitlementState, NetGrantItem };

/** Hộp thoại hệ thống "Cho phép <app> truy cập <host>?" (C9) do `net.requestAccess` bật. */
export interface AccessPrompt {
  appId: string;
  appName: string;
  host: string;
  reason: string | null;
}

export interface SessionInfo {
  email: string | null;
  sub: string | null;
  tenantId: string | null;
  /** Session id (thiết bị này) — khớp `DeviceRow.session_id`. */
  sessionId: string | null;
}

/** App trên launcher (đã cài trên máy này), đã sắp theo `installations.position`. */
export interface LauncherApp extends AppRow {
  /** Có bản mới đã tải, sẽ chạy ở lần mở sau (chấm C5 / banner C8). */
  updatePending: boolean;
  /** Bản bị thu hồi và không mở được (C5 mờ + gạch; mở ⇒ C14 "bản này đã bị thu hồi, cần mạng để cập nhật"). */
  blocked: boolean;
  /** Đã gỡ ở máy khác (installations.enabled = false) nhưng còn thay đổi chưa gửi — đang chờ gửi nốt. */
  removedElsewhere: boolean;
}

/** Thẻ app trong catalog. `action` là nút hành động chính của C4. */
export interface CatalogItem extends CatalogApp {
  local: AppRow | null;
  action: 'install' | 'open' | 'update' | 'unavailable';
  /** Gói đã gỡ khỏi máy này nhưng còn dữ liệu trên server (S4 hiện "Xoá hẳn dữ liệu"). */
  uninstalledWithData: boolean;
}

export interface InstallProgress {
  step: InstallStep;
  /** Có ⇒ lỗi, UI hiện chữ lỗi + nút Thử lại (C12 trạng thái lỗi). */
  error?: { code: string; message: string };
}

export interface ToastItem {
  id: number;
  kind: 'info' | 'intent' | 'error';
  text: string;
  /** Nút bên phải toast (vd "Mở"). */
  action?: { label: string; run(): void };
}

export interface RejectionRow {
  id: string;
  source: 'server' | 'local';
  app: string | null; // app_id nếu suy ra được
  table: string | null;
  op: string | null;
  code: string;
  detail: string | null;
  data: string | null; // JSON thu gọn
  createdAt: string;
}

export interface DeviceItem {
  id: string;
  sessionId: string;
  name: string;
  platform: string | null;
  lastSeenAt: string;
  isThisDevice: boolean;
}

export interface RuntimeState {
  boot: 'starting' | 'ready' | 'error';
  bootError: string | null;
  /** null ⇒ chưa đăng nhập ⇒ hiện S1. */
  session: SessionInfo | null;
  /** Lý do quay về S1 mà không do người dùng bấm: phiên hết hiệu lực / bị thu hồi. */
  loginHint: 'expired' | 'revoked' | null;
  /** PowerSync đang kết nối được. */
  online: boolean;
  sync: SyncStatus;
  entitlement: EntitlementState;
  plan: { plan: string; max_apps: number | null; until: string | null } | null;
  apps: LauncherApp[];
  catalog: {
    items: CatalogItem[];
    /** true ⇒ đang xem bản đã lưu (offline) — hiện banner "cần mạng để cài". */
    fromCache: boolean;
    loading: boolean;
    /** 'OFFLINE' khi chưa có cache và không có mạng; mã khác khi máy chủ lỗi. */
    error: string | null;
    fetchedAt: string | null;
  };
  installing: Record<string, InstallProgress>;
  /** App có WebView đang sống (tối đa 3), cũ nhất trước; `foreground` là app đang hiện ở S5 (null ⇒ đang ở launcher). */
  live: string[];
  foreground: string | null;
  /** App vừa được chạm mở và đang được chuẩn bị (kiểm catalog, hoán đổi bản mới) — UI vẽ splash "Đang mở…" ngay. */
  opening: string | null;
  /** Tên app đang bị chặn mở (APP_REVOKED) nếu người dùng vừa thử mở. */
  blockedOpen: { appId: string; name: string; message: string } | null;
  toasts: ToastItem[];
  rejections: RejectionRow[];
  unseenRejections: number;
  /** Số thay đổi đang chờ gửi (hàng đợi upload). */
  pendingChanges: number;
  /** Số file chưa upload. */
  pendingFiles: number;
  /** Hộp thoại xin quyền host đang mở (null ⇒ không). */
  accessPrompt: AccessPrompt | null;
  /** Domain do người dùng cho phép còn sống (mọi app) — S4 lọc theo app. */
  netGrants: NetGrantItem[];
}

export type SignOutResult = { done: true } | { done: false; pending: number };

export interface Runtime {
  getState(): RuntimeState;
  subscribe(fn: () => void): () => void;

  // ----- phiên -----
  /** Gọi sau khi `verifyOtp`/OAuth thành công. Cùng tài khoản trước đó ⇒ nối tiếp; khác tài khoản mà còn thay đổi chưa gửi ⇒ `needsChoice`. */
  completeSignIn(): Promise<{ ok: true } | { ok: false; needsChoice: { pending: number } }>;
  /** Người dùng chọn "Vẫn đổi" (xoá dữ liệu máy của tài khoản trước) hoặc "Ở lại" (huỷ phiên mới). */
  resolveAccountSwitch(choice: 'switch' | 'stay'): Promise<void>;
  /** Đăng xuất. Còn thay đổi chưa gửi mà `force` = false ⇒ trả `{done:false, pending}` để UI hỏi C9. */
  signOut(force?: boolean): Promise<SignOutResult>;

  // ----- catalog + app -----
  refreshCatalog(): Promise<void>;
  install(appId: string): Promise<void>;
  uninstall(appId: string): Promise<void>;
  /** "Xoá hẳn dữ liệu" của app đã gỡ (người dùng đã gõ XOÁ). Offline ⇒ ném PackageError('OFFLINE'). */
  purgeData(appId: string, onProgress?: (done: number) => void): Promise<void>;
  reorder(appIds: string[]): Promise<void>;
  dismissNotice(appId: string): Promise<void>;
  /** Mở app ở S5. Bị chặn ⇒ đặt `blockedOpen` thay vì ném. */
  openApp(appId: string): Promise<void>;
  /** BACK / nút ×: về launcher, giữ WebView sống (trong hạn 3). */
  closeForeground(): void;
  dismissBlockedOpen(): void;

  // ----- đồng bộ -----
  retrySync(): Promise<void>;
  markRejectionsSeen(): Promise<void>;

  // ----- thiết bị / tài khoản -----
  listDevices(): Promise<DeviceItem[]>;
  /** Thu hồi một thiết bị; thu hồi chính máy này = đăng xuất. */
  revokeDevice(id: string): Promise<void>;
  renameThisDevice(name: string): Promise<void>;
  /** `true` = đã liên kết; `false` = người dùng đóng trình duyệt giữa chừng (UI không báo thành công). Lỗi ⇒ ném (PROVIDER_UNAVAILABLE…). */
  linkProvider(provider: 'google' | 'apple'): Promise<boolean>;

  // ----- domain do người dùng cho phép (vòng 6) -----
  /** Người dùng trả lời hộp thoại xin quyền host (Cho phép / Không). */
  answerAccessPrompt(allow: boolean): void;
  /** Thu hồi: xoá mềm mọi dòng sống `(appId, host)`; lần `fetch` sau của app → NET_BLOCKED. */
  revokeNetGrant(appId: string, host: string): Promise<void>;

  // ----- toast -----
  pushToast(t: Omit<ToastItem, 'id'>): void;
  dismissToast(id: number): void;
}
