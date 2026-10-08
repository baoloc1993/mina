// Runtime của shell: gắn auth + sync + package manager + entitlement + vòng đời mini app + intent + native thành MỘT trạng thái
// `RuntimeState` cho UI (hợp đồng ở ./types). Mọi hiệu ứng của mini app đi qua `Host` (xem makeHost) SAU khi bridge guard xong.
import { AppState, Platform, Share } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as ImagePicker from 'expo-image-picker';
import * as FS from 'expo-file-system/legacy';
import * as semver from 'semver';
import type { PowerSyncDatabase } from '@powersync/react-native';
import { config } from '../config';
import { handleRpc, SDK_VERSION } from '../bridge/bridge';
import { BridgeError, type Host, type IntentOutcome, type RpcRequest, type SyncStatus } from '../bridge/types';
import {
  claimsOf,
  getAppToken,
  listDevices as listDevicesApi,
  oauth,
  registerDevice,
  renameThisDevice as renameApi,
  revokeDevice as revokeApi,
  supabase,
  tenantIdOf,
} from '../auth/supabase';
import * as api from '../auth/api';
import { UnauthorizedError } from '../auth/api';
import { EntitlementStore, type EntitlementCache } from '../entitlement/entitlement';
import { cancelAllOf, cancelNotification, listNotifications, onNotificationTap, restoreNotifications, scheduleNotification } from '../native/notifications';
import { APPS_DIR, createClock, downloadBytes, FILES_DIR, newScratch, nativeFs, uuid } from '../native/adapters';
import { FileStore } from '../native/fileStore';
import { nativeNetFetch } from '../native/netFetch';
import { PackageManager } from '../packages/manager';
import { PackageError, type AppRow, type CatalogResponse } from '../packages/types';
import { PowerSyncAppRepo, kvGet, kvSet } from '../store/repo';
import { Connector, type ConnectorHooks } from '../store/connector';
import { disconnectAndClear, openDatabase, rebuildSchema } from '../store/db';
import { receiversOf } from './intents';
import { LiveSet, SUSPEND_ACK_MS } from './liveSet';
import type {
  CatalogItem, DeviceItem, InstallProgress, LauncherApp, RejectionRow, Runtime, RuntimeState, SessionInfo, SignOutResult, ToastItem,
} from './types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const EMPTY_SYNC: SyncStatus = { state: 'offline', pending: 0, rejected: 0, lastSyncedAt: null };

export interface AppChannel {
  emit(name: string, payload: unknown): void;
}

export interface AppRuntimeInfo {
  row: AppRow;
  dir: string;
  /** Xử lý một lời gọi JSON-RPC từ WebView của app này. */
  rpc(req: RpcRequest): ReturnType<typeof handleRpc>;
}

function initialState(): RuntimeState {
  return {
    boot: 'starting', bootError: null, session: null, loginHint: null, online: false, sync: EMPTY_SYNC,
    entitlement: { readOnly: false, graceLeftMs: null, expired: false, reason: 'no-cache' }, plan: null, apps: [],
    catalog: { items: [], fromCache: false, loading: false, error: null, fetchedAt: null },
    installing: {}, live: [], foreground: null, blockedOpen: null, toasts: [], rejections: [], unseenRejections: 0,
    pendingChanges: 0, pendingFiles: 0,
  };
}

const SE = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

export class RuntimeImpl implements Runtime {
  private s: RuntimeState = initialState();
  private listeners = new Set<() => void>();
  private db!: PowerSyncDatabase;
  private repo!: PowerSyncAppRepo;
  private pm!: PackageManager;
  private files!: FileStore;
  private ent!: EntitlementStore;
  private live = new LiveSet();
  private infos = new Map<string, AppRuntimeInfo>();
  private channels = new Map<string, AppChannel>();
  private readyApps = new Set<string>();
  private readyWaiters = new Map<string, (() => void)[]>();
  private suspendWaiters = new Map<string, () => void>();
  private catalogResp: CatalogResponse | null = null;
  private installationsMap = new Map<string, { enabled: boolean; position: number | null; updated_at: string }>();
  private confirmedEnabled = new Set<string>();
  private seenRejections = new Set<string>();
  private pendingReorder: string[] | null = null;
  private lastCatalogAt = 0;
  private refreshing: Promise<void> | null = null;
  private toastSeq = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogBusy = false;
  private connected = false;
  private updateTried = new Set<string>();
  private signedOutByUs = false;
  private openTimes: number[] = [];
  private openStart = new Map<string, number>();
  private switchPending: { sub: string } | null = null;

  // ---------- trạng thái ----------
  getState = (): RuntimeState => this.s;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<RuntimeState>): void {
    this.s = { ...this.s, ...patch };
    this.listeners.forEach((f) => f());
  }

  /** Thông tin để `LiveApps` dựng WebView cho một app đang sống. */
  appInfo(appId: string): AppRuntimeInfo | undefined {
    return this.infos.get(appId);
  }
  registerChannel(appId: string, ch: AppChannel | null): void {
    if (ch) this.channels.set(appId, ch);
    else {
      this.channels.delete(appId);
      this.readyApps.delete(appId);
    }
  }
  /** Số đo mở app (ms từ lúc bấm tới sdk.ready) — ghi cho EXPERIMENTS-v3. */
  get openTimesMs(): readonly number[] {
    return this.openTimes;
  }

  // ---------- khởi động ----------
  async init(): Promise<void> {
    try {
      const clock = await createClock();
      this.db = await openDatabase();
      this.repo = new PowerSyncAppRepo(this.db);
      this.files = new FileStore(this.db, () => this.s.session?.tenantId ?? null);
      this.ent = new EntitlementStore(clock, async (c) => {
        if (c) await SecureStore.setItemAsync('ent_v1', JSON.stringify(c), SE);
        else await SecureStore.deleteItemAsync('ent_v1');
      });
      const raw = await SecureStore.getItemAsync('ent_v1');
      if (raw) this.ent.load(JSON.parse(raw) as EntitlementCache);
      this.ent.subscribe(() => this.set({ entitlement: this.ent.state }));
      this.pm = new PackageManager({
        appsDir: APPS_DIR,
        fs: nativeFs,
        download: downloadBytes,
        api: { installApp: api.installApp, uninstallApp: api.uninstallApp },
        trustedKeys: () => this.trustedKeys(),
        newScratch,
        repo: this.repo,
        onSchemaChanged: () => rebuildSchema(this.db),
        now: () => new Date().toISOString(),
        rand: () => Math.random().toString(36).slice(2, 8),
        recordFailure: async (appId, version, code, detail) => {
          await this.db.execute('INSERT INTO platform_rejections (id, app_id, version, code, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
            uuid(), appId, version, code, detail, new Date().toISOString(),
          ]);
          this.pushToast({ kind: 'error', text: `Không cập nhật được app (${code}) — bản cũ vẫn chạy` });
        },
      });
      const seen = await kvGet(this.db, 'rejections_seen');
      if (seen) this.seenRejections = new Set(JSON.parse(seen) as string[]);
      const confirmed = await kvGet(this.db, 'confirmed_enabled');
      if (confirmed) this.confirmedEnabled = new Set(JSON.parse(confirmed) as string[]);
      const ro = await kvGet(this.db, 'reorder_pending');
      if (ro) this.pendingReorder = JSON.parse(ro) as string[];
      const cached = await kvGet(this.db, 'catalog');
      if (cached) this.catalogResp = JSON.parse(cached) as CatalogResponse;
      const fetchedAt = await kvGet(this.db, 'catalog_at');

      supabase.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT' && this.s.session && !this.signedOutByUs) void this.expire('expired');
      });
      const { data } = await supabase.auth.getSession();
      await this.refreshApps();
      this.set({ catalog: { ...this.s.catalog, fetchedAt }, entitlement: this.ent.state });
      this.recomputeCatalog(true);
      if (data.session) await this.startSession(data.session.access_token);
      this.set({ boot: 'ready' });
      this.tickTimer = setInterval(() => void this.tick(), 1000);
      AppState.addEventListener('change', (st) => {
        if (st === 'active' && this.s.session) void this.refreshCatalog();
      });
      onNotificationTap(({ appId, ref }) => void this.openFromNotification(appId, ref));
      void restoreNotifications(this.db).catch(() => undefined);
    } catch (e) {
      this.set({ boot: 'error', bootError: (e as Error).message });
    }
  }

  private hooks(): ConnectorHooks {
    return {
      onUnauthorized: () => void this.expire('expired'),
      onReadOnly: () => this.ent.markServerReadOnly(),
      onRejected: () => void this.loadRejections(),
      onUploaded: () => void this.files.uploadPending().catch(() => undefined),
    };
  }

  private async trustedKeys(): Promise<Record<string, string>> {
    try {
      const keys = await api.fetchTrustedKeys();
      await SecureStore.setItemAsync('trusted_keys_v1', JSON.stringify(keys), SE);
      return keys;
    } catch {
      const raw = await SecureStore.getItemAsync('trusted_keys_v1');
      return raw ? (JSON.parse(raw) as Record<string, string>) : {}; // rỗng + offline ⇒ UNTRUSTED_KEY
    }
  }

  // ---------- phiên ----------
  private sessionInfoFrom(token: string): SessionInfo {
    const c = claimsOf(token);
    return { email: c.email ?? null, sub: c.sub ?? null, tenantId: c.tenant_id ?? tenantIdOf(token), sessionId: c.session_id ?? null };
  }

  private async startSession(token: string): Promise<void> {
    this.signedOutByUs = false;
    const info = this.sessionInfoFrom(token);
    if (info.sub) await kvSet(this.db, 'last_sub', info.sub);
    this.set({ session: info, loginHint: null });
    await this.db.connect(new Connector(this.hooks()));

    void registerDevice().catch(() => undefined);
    void this.refreshCatalog(true);
    void this.files.uploadPending().catch(() => undefined);
  }

  /** 401 / phiên hết hiệu lực ⇒ về S1 nhưng GIỮ hàng đợi + DB local (đăng nhập lại cùng tài khoản thì gửi tiếp). */
  private async expire(hint: 'expired' | 'revoked'): Promise<void> {
    if (!this.s.session) return;
    this.signedOutByUs = true;
    this.live.live.forEach((a) => this.live.remove(a));
    this.infos.clear();
    this.set({ session: null, loginHint: hint, live: [], foreground: null, installing: {} });
    await this.db.disconnect().catch(() => undefined);
    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  }

  async completeSignIn(): ReturnType<Runtime['completeSignIn']> {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return { ok: false, needsChoice: { pending: 0 } };
    const sub = claimsOf(data.session.access_token).sub ?? null;
    const last = await kvGet(this.db, 'last_sub');
    if (!last || !sub || last === sub) {
      await this.startSession(data.session.access_token);
      return { ok: true };
    }
    const pending = (await this.db.getUploadQueueStats()).count;
    if (pending === 0) {
      await this.wipeLocal();
      await this.startSession(data.session.access_token);
      return { ok: true };
    }
    this.switchPending = { sub };
    return { ok: false, needsChoice: { pending } };
  }

  async resolveAccountSwitch(choice: 'switch' | 'stay'): Promise<void> {
    if (!this.switchPending) return;
    this.switchPending = null;
    if (choice === 'stay') {
      this.signedOutByUs = true;
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      return;
    }
    const { data } = await supabase.auth.getSession();
    await this.wipeLocal();
    if (data.session) await this.startSession(data.session.access_token);
  }

  /** Xoá mọi dữ liệu trên máy của tài khoản trước: DB, gói, file, thông báo, Keystore app. */
  private async wipeLocal(): Promise<void> {
    await this.db.disconnect().catch(() => undefined);
    for (const a of await this.repo.list()) await cancelAllOf(this.db, a.app_id).catch(() => undefined);
    await disconnectAndClear(this.db);
    await FS.deleteAsync(APPS_DIR, { idempotent: true });
    await FS.deleteAsync(FILES_DIR, { idempotent: true });
    await SecureStore.deleteItemAsync('ent_v1').catch(() => undefined);
    this.ent.load(null);
    this.confirmedEnabled.clear();
    this.seenRejections.clear();
    this.pendingReorder = null;
    this.catalogResp = null;
    this.installationsMap.clear();
    this.infos.clear();
    this.live = new LiveSet();
    await rebuildSchema(this.db);
    this.set({ apps: [], live: [], foreground: null, rejections: [], unseenRejections: 0, installing: {}, plan: null });
    this.recomputeCatalog(false);
  }

  async signOut(force = false): Promise<SignOutResult> {
    const pending = (await this.db.getUploadQueueStats()).count;
    if (pending > 0 && !force) return { done: false, pending };
    this.signedOutByUs = true;
    await this.wipeLocal();
    await kvSet(this.db, 'last_sub', null);
    await supabase.auth.signOut().catch(() => undefined);
    this.set({ session: null, loginHint: null, catalog: { ...this.s.catalog, items: [], fromCache: false, fetchedAt: null, error: null } });
    return { done: true };
  }

  // ---------- catalog + app ----------
  refreshCatalog = async (force = false): Promise<void> => {
    if (!this.s.session) return;
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.lastCatalogAt < 10_000) return;
    this.refreshing = (async () => {
      this.set({ catalog: { ...this.s.catalog, loading: true } });
      try {
        const resp = await api.fetchCatalog();
        this.lastCatalogAt = Date.now();
        this.catalogResp = resp;
        const now = new Date().toISOString();
        await kvSet(this.db, 'catalog', JSON.stringify(resp));
        await kvSet(this.db, 'catalog_at', now);
        if (resp.entitlement && resp.server_time) await this.ent.verified(resp.entitlement, resp.server_time);
        this.set({
          plan: resp.entitlement ? { plan: resp.entitlement.plan, max_apps: resp.entitlement.max_apps, until: resp.entitlement.until } : this.s.plan,
          catalog: { ...this.s.catalog, fromCache: false, error: null, fetchedAt: now },
        });
        const events = await this.pm.reconcile(resp.apps).catch((e) => {
          if (e instanceof PackageError && e.code === 'OFFLINE') return [];
          throw e;
        });
        for (const ev of events) {
          if (ev.kind === 'failed') this.updateTried.add(`${ev.appId}@${ev.version}`);
        }
        await this.refreshApps();
      } catch (e) {
        if (e instanceof UnauthorizedError) {
          void this.expire('expired');
        } else {
          const offline = e instanceof PackageError && e.code === 'OFFLINE';
          this.set({
            catalog: { ...this.s.catalog, fromCache: !!this.catalogResp, error: this.catalogResp ? null : offline ? 'OFFLINE' : ((e as PackageError).code ?? 'INTERNAL') },
          });
        }
      } finally {
        this.recomputeCatalog(this.s.catalog.fromCache);
        this.set({ catalog: { ...this.s.catalog, loading: false } });
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  };

  private recomputeCatalog(fromCache: boolean): void {
    const apps = this.catalogResp?.apps ?? [];
    const local = new Map(this.s.apps.map((a) => [a.app_id, a as AppRow]));
    const items: CatalogItem[] = apps.map((c) => {
      const l = local.get(c.id) ?? null;
      let action: CatalogItem['action'];
      if (l) {
        action = c.version && (l.pending_version || semver.gt(c.version, l.current_version)) ? 'update' : 'open';
        if (l.status === 'revoked') action = 'unavailable';
      } else action = !c.version || c.code === 'NO_SAFE_VERSION' ? 'unavailable' : 'install';
      const inst = this.installationsMap.get(c.id);
      return { ...c, local: l, action, uninstalledWithData: !l && !!inst && !inst.enabled };
    });
    this.set({ catalog: { ...this.s.catalog, items, fromCache: fromCache && !!this.catalogResp } });
  }

  private setInstalling(appId: string, p: InstallProgress | null): void {
    const next = { ...this.s.installing };
    if (p) next[appId] = p;
    else delete next[appId];
    this.set({ installing: next });
  }

  install = async (appId: string): Promise<void> => {
    const c = this.catalogResp?.apps.find((a) => a.id === appId);
    if (!c) throw new PackageError('NOT_FOUND', 'Không thấy app trong catalog');
    if (this.s.installing[appId] && !this.s.installing[appId].error) return;
    this.setInstalling(appId, { step: 'download' });
    try {
      const existing = await this.repo.get(appId);
      if (existing) {
        // Cập nhật thủ công: tải bản mới thành pending (áp ở lần mở sau).
        await this.pm.reconcile([c]);
      } else {
        await this.pm.install(c, (step) => this.setInstalling(appId, { step }));
      }
      this.confirmedEnabled.add(appId);
      await kvSet(this.db, 'confirmed_enabled', JSON.stringify([...this.confirmedEnabled]));
      this.setInstalling(appId, null);
      await this.refreshApps();
      this.recomputeCatalog(this.s.catalog.fromCache);
    } catch (e) {
      const code = e instanceof PackageError ? e.code : e instanceof UnauthorizedError ? 'UNAUTHORIZED' : 'INTERNAL';
      this.setInstalling(appId, { step: this.s.installing[appId]?.step ?? 'download', error: { code, message: (e as Error).message } });
      if (e instanceof UnauthorizedError) void this.expire('expired');
      throw e;
    }
  };

  uninstall = async (appId: string): Promise<void> => {
    if (this.live.live.includes(appId)) await this.suspendAndRemove(appId);
    await this.pm.uninstall(appId).catch((e) => {
      if (e instanceof PackageError && e.code === 'APP_NOT_INSTALLED') return this.pm.removeLocal(appId);
      throw e;
    });
    await cancelAllOf(this.db, appId).catch(() => undefined);
    this.confirmedEnabled.delete(appId);
    await kvSet(this.db, 'confirmed_enabled', JSON.stringify([...this.confirmedEnabled]));
    await this.refreshApps();
    this.recomputeCatalog(this.s.catalog.fromCache);
  };

  purgeData = async (appId: string, onProgress?: (done: number) => void): Promise<void> => {
    if (await this.repo.get(appId)) throw new PackageError('INTERNAL', 'Chỉ xoá hẳn dữ liệu của app đã gỡ');
    const tables = await api.serverTablesOf(appId);
    let done = 0;
    for (const t of tables) {
      for (;;) {
        const ids = await api.liveIds(t, 0, 100);
        if (!ids.length) break;
        await api.uploadDeletes(t, ids);
        done += ids.length;
        onProgress?.(done);
      }
    }
  };

  reorder = async (appIds: string[]): Promise<void> => {
    this.pendingReorder = appIds;
    await kvSet(this.db, 'reorder_pending', JSON.stringify(appIds));
    appIds.forEach((id, i) => {
      const inst = this.installationsMap.get(id);
      if (inst) inst.position = i;
    });
    for (const [i, id] of appIds.entries()) {
      const r = await this.repo.get(id);
      if (r) await this.repo.put({ ...r, position: i });
    }
    await this.refreshApps();
    await this.flushReorder();
  };

  private async flushReorder(): Promise<void> {
    if (!this.pendingReorder || !this.s.session) return;
    try {
      await api.reorderApps(this.pendingReorder);
      this.pendingReorder = null;
      await kvSet(this.db, 'reorder_pending', null);
    } catch (e) {
      if (e instanceof PackageError && e.code === 'OFFLINE') return; // thử lại khi có mạng
      if (e instanceof PackageError && e.code === 'SESSION_REVOKED') void this.expire('revoked');
    }
  }

  dismissNotice = async (appId: string): Promise<void> => {
    await this.pm.dismissNotice(appId);
    await this.refreshApps();
  };

  /** Dựng `apps` (launcher) từ kho local + bảng `installations` đã sync. */
  private async refreshApps(): Promise<void> {
    const rows = await this.repo.list();
    const pending = this.s.pendingChanges;
    const apps: LauncherApp[] = rows
      .map((r) => {
        const inst = this.installationsMap.get(r.app_id);
        const position = this.pendingReorder ? this.pendingReorder.indexOf(r.app_id) : inst?.position ?? r.position;
        return {
          ...r,
          position: position === -1 ? null : position,
          updatePending: !!r.pending_version,
          blocked: r.status === 'revoked',
          removedElsewhere: !!inst && !inst.enabled && this.confirmedEnabled.has(r.app_id) && pending > 0,
        };
      })
      .sort((a, b) => {
        const pa = a.position ?? Number.MAX_SAFE_INTEGER;
        const pb = b.position ?? Number.MAX_SAFE_INTEGER;
        return pa !== pb ? pa - pb : a.installed_at.localeCompare(b.installed_at);
      });
    this.set({ apps });
  }

  // ---------- mở app / vòng đời ----------
  openApp = async (appId: string): Promise<void> => {
    this.openStart.set(appId, Date.now());
    this.set({ blockedOpen: null });
    const alreadyLive = this.live.live.includes(appId);
    if (!alreadyLive) {
      // Biết bản mới / bị thu hồi TRƯỚC khi nạp (đừng chờ quá 2,5 s).
      if (this.s.online && this.s.session) await Promise.race([this.refreshCatalog(true), sleep(2500)]);
      try {
        const { row, dir } = await this.pm.prepareOpen(appId);
        this.infos.set(appId, { row, dir, rpc: (req) => handleRpc(req, { manifest: row.manifest, tablePrefix: row.table_prefix, host: this.makeHost(row) }) });
        await this.refreshApps();
      } catch (e) {
        const name = this.s.apps.find((a) => a.app_id === appId)?.name ?? appId;
        if (e instanceof PackageError && e.code === 'APP_REVOKED') {
          this.set({ blockedOpen: { appId, name, message: 'Bản này đã bị thu hồi, cần mạng để cập nhật' } });
          return;
        }
        this.pushToast({ kind: 'error', text: `Không mở được ${name} (${(e as PackageError).code ?? 'INTERNAL'})` });
        return;
      }
    }
    const { resumed, evict } = this.live.open(appId);
    this.publishLive();
    if (resumed) this.channels.get(appId)?.emit('resume', {});
    for (const old of evict) void this.suspendAndRemove(old);
  };

  closeForeground = (): void => {
    this.live.closeForeground();
    this.publishLive();
  };
  dismissBlockedOpen = (): void => this.set({ blockedOpen: null });

  private publishLive(): void {
    this.set({ live: [...this.live.live], foreground: this.live.foreground });
  }

  private async suspendAndRemove(appId: string): Promise<void> {
    const ch = this.channels.get(appId);
    if (ch && this.readyApps.has(appId)) {
      const ack = new Promise<void>((res) => this.suspendWaiters.set(appId, res));
      ch.emit('suspend', {});
      await Promise.race([ack, sleep(SUSPEND_ACK_MS)]);
      this.suspendWaiters.delete(appId);
    }
    this.live.remove(appId);
    this.infos.delete(appId);
    this.readyApps.delete(appId);
    this.publishLive();
  }

  private onAppReady(appId: string): void {
    const t0 = this.openStart.get(appId);
    if (t0) {
      const ms = Date.now() - t0;
      this.openTimes.push(ms);
      this.openStart.delete(appId);
      console.log(`[miniapp] ${appId} ready sau ${ms} ms`);
    }
    this.readyApps.add(appId);
    (this.readyWaiters.get(appId) ?? []).forEach((f) => f());
    this.readyWaiters.delete(appId);
    void this.flushQueuedIntents(appId);
  }

  private whenReady(appId: string, ms: number): Promise<void> {
    if (this.readyApps.has(appId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      this.readyWaiters.set(appId, [...(this.readyWaiters.get(appId) ?? []), () => (clearTimeout(timer), resolve())]);
    });
  }

  // ---------- intent ----------
  private async deliverIntent(from: AppRow, i: { type: string; version: string; payload: unknown; mode: 'create' | 'open'; to: string }): Promise<IntentOutcome> {
    const target = this.s.apps.find((a) => a.app_id === i.to);
    if (!target || target.status === 'revoked') throw new BridgeError('INTENT_NO_HANDLER', 'App nhận không còn dùng được');
    const evt = { type: i.type, version: i.version, payload: i.payload, from: from.app_id };
    if (i.mode === 'open') {
      await this.openApp(i.to);
      await this.whenReady(i.to, 10_000).catch(() => undefined);
      this.channels.get(i.to)?.emit('intent', evt);
      return 'opened';
    }
    const toast = () =>
      this.pushToast({ kind: 'intent', text: `Đã gửi tới ${target.name}`, action: { label: 'Mở?', run: () => void this.openApp(i.to) } });
    if (!this.live.live.includes(i.to)) {
      try {
        const { row, dir } = await this.pm.prepareOpen(i.to);
        this.infos.set(i.to, { row, dir, rpc: (req) => handleRpc(req, { manifest: row.manifest, tablePrefix: row.table_prefix, host: this.makeHost(row) }) });
        const { evict } = this.live.openBackground(i.to);
        this.publishLive();
        for (const old of evict) void this.suspendAndRemove(old);
        await this.whenReady(i.to, 10_000);
      } catch {
        await this.db.execute('INSERT INTO platform_intents (id, type, version, payload, from_app, to_app, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          uuid(), i.type, i.version, JSON.stringify(i.payload), from.app_id, i.to, new Date().toISOString(),
        ]);
        toast();
        return 'queued';
      }
    }
    this.channels.get(i.to)?.emit('intent', evt);
    toast();
    return 'handled';
  }

  private async flushQueuedIntents(appId: string): Promise<void> {
    const rows = await this.db.getAll<{ id: string; type: string; version: string; payload: string; from_app: string }>(
      'SELECT * FROM platform_intents WHERE to_app = ? ORDER BY created_at',
      [appId],
    );
    for (const r of rows) {
      this.channels.get(appId)?.emit('intent', { type: r.type, version: r.version, payload: JSON.parse(r.payload), from: r.from_app });
      await this.db.execute('DELETE FROM platform_intents WHERE id = ?', [r.id]);
    }
  }

  private async openFromNotification(appId: string, ref: string | null): Promise<void> {
    if (!this.s.apps.some((a) => a.app_id === appId)) return;
    await this.openApp(appId);
    await this.whenReady(appId, 10_000).catch(() => undefined);
    this.channels.get(appId)?.emit('intent', { type: 'platform.notification.open', version: '1', payload: { ref }, from: 'platform' });
  }

  // ---------- Host của một app ----------
  private makeHost(row: AppRow): Host {
    const appId = row.app_id;
    const hasScope = (s: string) => row.manifest.scopes.includes(s) || row.manifest.scopes.includes(s.replace(/:read$/, ':write'));
    return {
      now: () => new Date().toISOString(),
      newId: uuid,
      tenantId: () => this.s.session?.tenantId ?? null,
      isReadOnly: () => this.ent.isReadOnly(),
      sdkInfo: () => ({ sdkVersion: SDK_VERSION, platform: Platform.OS }),
      db: {
        all: (sql, params) => this.db.getAll(sql, params as unknown[]),
        run: async (sql, params) => void (await this.db.execute(sql, params as unknown[])),
        transaction: async (stmts) => {
          await this.db.writeTransaction(async (tx) => {
            for (const st of stmts) await tx.execute(st.sql, st.params as unknown[]);
          });
        },
      },
      sync: { status: () => this.s.sync },
      auth: { appToken: getAppToken },
      lifecycle: {
        ready: () => this.onAppReady(appId),
        suspended: () => this.suspendWaiters.get(appId)?.(),
      },
      notify: {
        schedule: (n) => scheduleNotification(this.db, appId, n),
        cancel: (id) => cancelNotification(this.db, appId, id),
        list: () => listNotifications(this.db, appId),
      },
      storage: {
        put: (f) => this.files.put(appId, f),
        get: (id) => this.files.get(appId, id, hasScope('core.files:read')),
        remove: (id) => this.files.remove(appId, id),
      },
      net: { fetch: nativeNetFetch },
      ui: {
        toast: (text) => this.pushToast({ kind: 'info', text }),
        pickImage: async ({ multiple }) => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) throw new BridgeError('PERMISSION_DENIED', 'Người dùng chưa cho phép truy cập ảnh');
          const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: multiple, base64: true, quality: 0.8 });
          if (r.canceled) return { files: [] };
          const files: { fileId: string; uri: string; mime: string }[] = [];
          for (const a of r.assets) {
            const mime = a.mimeType ?? 'image/jpeg';
            const stored = await this.files.put(appId, { name: a.fileName ?? `anh-${Date.now()}.jpg`, mime, base64: a.base64 ?? '' });
            files.push({ fileId: stored.fileId, uri: stored.uri, mime });
          }
          return { files };
        },
        share: async ({ title, text, url }) => {
          await Share.share({ title, message: [text, url].filter(Boolean).join('\n'), ...(url ? { url } : {}) });
        },
      },
      intent: {
        receivers: (type, version) => receiversOf(this.s.apps, type, version),
        deliver: (i) => this.deliverIntent(row, i),
      },
    };
  }

  // ---------- đồng bộ ----------
  private async tick(): Promise<void> {
    if (!this.db || this.s.boot !== 'ready') return;
    try {
      const st = this.db.currentStatus;
      const connected = !!st?.connected;
      const wasConnected = this.connected;
      this.connected = connected;
      const q = await this.db.getUploadQueueStats();
      const pendingFiles = await this.files.pendingCount();
      await this.loadInstallations();
      await this.loadRejections();
      const unseen = this.s.rejections.filter((r) => !this.seenRejections.has(r.id)).length;
      const uploadErr = st?.dataFlowStatus?.uploadError;
      let state: SyncStatus['state'] = 'online';
      if (!connected) state = 'offline';
      else if (unseen > 0 || (uploadErr && q.count > 0)) state = 'error';
      else if (st?.dataFlowStatus?.uploading || st?.dataFlowStatus?.downloading || q.count > 0) state = 'syncing';
      const sync: SyncStatus = {
        state, pending: q.count, rejected: unseen,
        lastSyncedAt: st?.lastSyncedAt ? new Date(st.lastSyncedAt).toISOString() : null,
      };
      const changed = JSON.stringify(sync) !== JSON.stringify(this.s.sync) || connected !== this.s.online || q.count !== this.s.pendingChanges || pendingFiles !== this.s.pendingFiles || unseen !== this.s.unseenRejections;
      if (changed) this.set({ sync, online: connected, pendingChanges: q.count, pendingFiles, unseenRejections: unseen });
      if (!wasConnected && connected && this.s.session) {
        void this.refreshCatalog(true);
        void this.flushReorder();
        void this.files.uploadPending().catch(() => undefined);
      }
      if (connected && this.pendingReorder) void this.flushReorder();
      await this.reconcileInstallations(q.count);
      await this.watchdog(connected);
    } catch {
      // DB đang bận — nhịp sau
    }
  }

  private async loadInstallations(): Promise<void> {
    const rows = await this.db.getAll<{ app_id: string; enabled: number; position: number | null; updated_at: string }>(
      'SELECT app_id, enabled, position, updated_at FROM installations',
    );
    const next = new Map(rows.map((r) => [r.app_id, { enabled: !!r.enabled, position: r.position, updated_at: r.updated_at }]));
    let changed = next.size !== this.installationsMap.size;
    for (const [k, v] of next) {
      const o = this.installationsMap.get(k);
      if (!o || o.enabled !== v.enabled || o.position !== v.position) changed = true;
      if (v.enabled && !this.confirmedEnabled.has(k)) {
        this.confirmedEnabled.add(k);
        void kvSet(this.db, 'confirmed_enabled', JSON.stringify([...this.confirmedEnabled]));
      }
    }
    if (changed) {
      this.installationsMap = next;
      await this.refreshApps();
      this.recomputeCatalog(this.s.catalog.fromCache);
    }
  }

  /** Máy khác gỡ app ⇒ gỡ local, nhưng CHỈ sau khi hàng đợi upload đã gửi hết (không mất thay đổi chưa gửi). */
  private async reconcileInstallations(pending: number): Promise<void> {
    if (pending > 0 || !this.s.session) return;
    for (const a of this.s.apps) {
      const inst = this.installationsMap.get(a.app_id);
      if (inst && !inst.enabled && this.confirmedEnabled.has(a.app_id) && !this.s.installing[a.app_id]) {
        if (this.live.live.includes(a.app_id)) continue; // đang mở: để lần sau
        await this.pm.removeLocal(a.app_id);
        await cancelAllOf(this.db, a.app_id).catch(() => undefined);
        this.confirmedEnabled.delete(a.app_id);
        await kvSet(this.db, 'confirmed_enabled', JSON.stringify([...this.confirmedEnabled]));
        this.pushToast({ kind: 'info', text: `${a.name} đã được gỡ ở máy khác` });
        await this.refreshApps();
        this.recomputeCatalog(this.s.catalog.fromCache);
      }
    }
  }

  /** Sau khi mạng quay lại, kết nối PowerSync đôi khi treo ~40 s (đo ở vòng 1) — nối lại ngay khi server tới được. */
  private async watchdog(connected: boolean): Promise<void> {
    if (connected || this.watchdogBusy || !this.s.session) return;
    this.watchdogBusy = true;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 2000);
      const r = await fetch(`${config.powersyncUrl}/probes/liveness`, { signal: ctl.signal });
      clearTimeout(to);
      if (r.ok && !this.db.currentStatus?.connected) await this.retrySync();
    } catch {
      // vẫn offline thật
    } finally {
      this.watchdogBusy = false;
    }
  }

  retrySync = async (): Promise<void> => {
    if (!this.s.session) return;
    await this.db.disconnect().catch(() => undefined);
    await this.db.connect(new Connector(this.hooks()));

  };

  private async loadRejections(): Promise<void> {
    const server = await this.db.getAll<{ id: string; table_name: string; op: string; code: string; detail: string | null; data: string | null; created_at: string }>(
      'SELECT id, table_name, op, code, detail, data, created_at FROM sync_rejections ORDER BY created_at DESC LIMIT 200',
    );
    const local = await this.db.getAll<{ id: string; app_id: string; version: string; code: string; detail: string | null; created_at: string }>(
      'SELECT * FROM platform_rejections ORDER BY created_at DESC LIMIT 200',
    );
    const appOf = (table: string) => this.s.apps.find((a) => table.startsWith(`${a.table_prefix}_`))?.app_id ?? null;
    const rows: RejectionRow[] = [
      ...server.map((r): RejectionRow => ({
        id: r.id, source: 'server', app: appOf(r.table_name), table: r.table_name, op: r.op, code: r.code, detail: r.detail,
        data: r.data ? r.data.slice(0, 600) : null, createdAt: r.created_at,
      })),
      ...local.map((r): RejectionRow => ({
        id: r.id, source: 'local', app: r.app_id, table: null, op: `cập nhật ${r.version}`, code: r.code, detail: r.detail, data: null, createdAt: r.created_at,
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (JSON.stringify(rows.map((r) => r.id)) !== JSON.stringify(this.s.rejections.map((r) => r.id))) this.set({ rejections: rows });
  }

  markRejectionsSeen = async (): Promise<void> => {
    this.s.rejections.forEach((r) => this.seenRejections.add(r.id));
    const keep = [...this.seenRejections].slice(-500);
    this.seenRejections = new Set(keep);
    await kvSet(this.db, 'rejections_seen', JSON.stringify(keep));
    this.set({ unseenRejections: 0, sync: { ...this.s.sync, rejected: 0, state: this.s.sync.state === 'error' && this.s.sync.pending === 0 ? 'online' : this.s.sync.state } });
  };

  // ---------- thiết bị / tài khoản ----------
  listDevices = async (): Promise<DeviceItem[]> => {
    const rows = await listDevicesApi();
    return rows.map((d) => ({
      id: d.id, sessionId: d.session_id, name: d.name ?? 'Thiết bị chưa đặt tên', platform: d.platform, lastSeenAt: d.last_seen_at,
      isThisDevice: d.session_id === this.s.session?.sessionId,
    }));
  };
  revokeDevice = async (id: string): Promise<void> => {
    const mine = (await this.listDevices()).find((d) => d.id === id)?.isThisDevice;
    await revokeApi(id);
    if (mine) await this.signOut(true);
  };
  renameThisDevice = async (name: string): Promise<void> => renameApi(name);
  linkProvider = async (provider: 'google' | 'apple'): Promise<void> => oauth(provider, true);

  // ---------- toast ----------
  pushToast = (t: Omit<ToastItem, 'id'>): void => {
    const id = ++this.toastSeq;
    this.set({ toasts: [...this.s.toasts.slice(-2), { ...t, id }] });
    setTimeout(() => this.dismissToast(id), 4000);
  };
  dismissToast = (id: number): void => {
    if (this.s.toasts.some((x) => x.id === id)) this.set({ toasts: this.s.toasts.filter((x) => x.id !== id) });
  };
}
