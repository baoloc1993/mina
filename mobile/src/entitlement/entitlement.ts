// Entitlement cache + chế độ chỉ đọc (CAP-ENT-02, AC-13). THUẦN TS — đồng hồ được bơm vào để test và để mock dùng chung.
// Nguyên tắc: không tin đồng hồ treo tường của máy. Thời gian trôi kể từ lần xác minh cuối đo bằng đồng hồ ĐƠN ĐIỆU
// (uptime hệ thống, sống qua lần mở lại app, chỉ reset khi khởi động lại máy); đồng hồ treo tường chỉ dùng để bắt
// gian lận (lùi về trước lần xác minh) và làm phương án thay khi máy vừa khởi động lại.

export interface EntitlementCache {
  plan: string;
  max_apps: number | null;
  /** ISO — hạn gói; null = không hết hạn (mvp-unlimited). */
  until: string | null;
  grace_days: number;
  /** ISO — `server_time` của lần `catalog` thành công cuối. */
  verified_server_time: string;
  /** Giá trị đồng hồ đơn điệu (ms) lúc xác minh. */
  verified_monotonic: number;
  /** Đồng hồ treo tường (ms) lúc xác minh. */
  verified_wall: number;
}

export interface Clock {
  /** ms từ lúc máy khởi động (SystemClock.elapsedRealtime). */
  monotonicMs(): number;
  wallMs(): number;
}

export const DEFAULT_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface CatalogEntitlement {
  plan: string;
  max_apps: number | null;
  until: string | null;
  grace_days?: number;
}

export function buildCache(ent: CatalogEntitlement, serverTime: string, clock: Clock): EntitlementCache {
  return {
    plan: ent.plan,
    max_apps: ent.max_apps ?? null,
    until: ent.until ?? null,
    grace_days: ent.grace_days ?? DEFAULT_GRACE_DAYS,
    verified_server_time: serverTime,
    verified_monotonic: clock.monotonicMs(),
    verified_wall: clock.wallMs(),
  };
}

/** Ước lượng "giờ server bây giờ" (ms) từ lần xác minh cuối; null nếu đồng hồ bị chỉnh lùi / không tin được. */
export function estimateServerNow(c: EntitlementCache, clock: Clock): number | null {
  const base = Date.parse(c.verified_server_time);
  if (!Number.isFinite(base)) return null;
  const wallElapsed = clock.wallMs() - c.verified_wall;
  const monoElapsed = clock.monotonicMs() - c.verified_monotonic;
  // Đồng hồ treo tường lùi về trước lần xác minh ⇒ gian lận (hoặc lệch quá) ⇒ coi như hết ân hạn tới khi online.
  if (wallElapsed < 0) return null;
  // Máy khởi động lại: đồng hồ đơn điệu quay về 0 (âm) ⇒ dùng đồng hồ treo tường (đã chặn lùi ở trên).
  const elapsed = monoElapsed >= 0 ? monoElapsed : wallElapsed;
  return base + elapsed;
}

export interface EntitlementState {
  readOnly: boolean;
  /** ms còn lại của ân hạn khi đã quá hạn gói nhưng chưa hết ân hạn; null nếu không áp dụng. */
  graceLeftMs: number | null;
  /** Gói đã quá hạn (đang trong ân hạn hoặc đã chỉ đọc). */
  expired: boolean;
  reason: 'ok' | 'no-cache' | 'unlimited' | 'in-grace' | 'grace-over' | 'clock-rolled-back' | 'server-read-only';
}

export function evaluate(c: EntitlementCache | null, clock: Clock, serverSaysReadOnly = false): EntitlementState {
  if (serverSaysReadOnly) return { readOnly: true, graceLeftMs: 0, expired: true, reason: 'server-read-only' };
  // Chưa từng xác minh ⇒ chưa biết gì ⇒ không chặn (máy mới offline vẫn dùng được app đã cài).
  if (!c) return { readOnly: false, graceLeftMs: null, expired: false, reason: 'no-cache' };
  if (c.until === null) return { readOnly: false, graceLeftMs: null, expired: false, reason: 'unlimited' };
  const until = Date.parse(c.until);
  if (!Number.isFinite(until)) return { readOnly: false, graceLeftMs: null, expired: false, reason: 'ok' };
  const now = estimateServerNow(c, clock);
  if (now === null) return { readOnly: true, graceLeftMs: 0, expired: true, reason: 'clock-rolled-back' };
  if (now <= until) return { readOnly: false, graceLeftMs: null, expired: false, reason: 'ok' };
  const left = until + c.grace_days * DAY_MS - now;
  return left > 0
    ? { readOnly: false, graceLeftMs: left, expired: true, reason: 'in-grace' }
    : { readOnly: true, graceLeftMs: 0, expired: true, reason: 'grace-over' };
}

/** Giữ state + phát thay đổi; Host.isReadOnly() đọc từ đây. */
export class EntitlementStore {
  private cache: EntitlementCache | null = null;
  private serverReadOnly = false;
  private listeners = new Set<() => void>();
  constructor(
    private clock: Clock,
    private persist: (c: EntitlementCache | null) => Promise<void> = async () => undefined,
  ) {}

  load(c: EntitlementCache | null): void {
    this.cache = c;
    this.emit();
  }
  /** Gọi sau mỗi `catalog` thành công. */
  async verified(ent: CatalogEntitlement, serverTime: string): Promise<void> {
    this.cache = buildCache(ent, serverTime, this.clock);
    this.serverReadOnly = false; // xác minh mới ⇒ tin catalog hơn lần 403 trước
    await this.persist(this.cache);
    this.emit();
  }
  /** `upload` trả 403 READ_ONLY — server đã quyết, kể cả khi cache cục bộ chưa thấy. */
  markServerReadOnly(): void {
    if (!this.serverReadOnly) {
      this.serverReadOnly = true;
      this.emit();
    }
  }
  clear(): void {
    this.cache = null;
    this.serverReadOnly = false;
    void this.persist(null);
    this.emit();
  }
  get state(): EntitlementState {
    return evaluate(this.cache, this.clock, this.serverReadOnly);
  }
  get snapshot(): EntitlementCache | null {
    return this.cache;
  }
  isReadOnly(): boolean {
    return this.state.readOnly;
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    this.listeners.forEach((f) => f());
  }
}
