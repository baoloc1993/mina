// Quyết định "nạp nền theo đồng bộ" cho app có scope `notify.local` (contract `shell-notify-reconcile`).
// THUẦN TS: không import react-native/expo; `now` do bên gọi bơm vào.
//   - app đang sống + chữ ký bảng đổi  ⇒ 'emit-sync' (app tự đối chiếu)
//   - app không sống + chữ ký đổi / lần đồng bộ đầu của phiên ⇒ bẩn; bẩn và (chưa nạp lần nào | ≥ throttle) ⇒ 'load'
//   - bẩn nhưng còn trong cửa sổ throttle ⇒ GIỮ bẩn, nhịp sau thử lại (đuôi của throttle — không nuốt thay đổi)
export const RECONCILE_THROTTLE_MS = 30_000;
export type ReconcileAction = 'none' | 'load' | 'emit-sync';

export class NotifyReconciler {
  private sigs = new Map<string, string>();
  private dirty = new Set<string>();
  private lastLoad = new Map<string, number>();
  private seen = new Set<string>(); // đã nạp / đã sống trong phiên này
  private firstSync = false;

  constructor(private throttleMs = RECONCILE_THROTTLE_MS) {}

  /** Đổi phiên (startSession / expire / signOut / wipeLocal). */
  reset(): void {
    this.sigs.clear();
    this.dirty.clear();
    this.lastLoad.clear();
    this.seen.clear();
    this.firstSync = false;
  }

  /** Lần đồng bộ đầu của phiên đã xong (gọi nhiều lần cũng chỉ tính một). */
  markFirstSync(): void {
    this.firstSync = true;
  }

  /** `sig` null (bảng lỗi/chưa có) ⇒ bỏ qua nhịp này. */
  decide(now: number, appId: string, sig: string | null, live: boolean): ReconcileAction {
    if (sig === null) return 'none';
    const prev = this.sigs.get(appId);
    this.sigs.set(appId, sig);
    const changed = prev !== undefined && prev !== sig;
    if (live) {
      this.seen.add(appId);
      const was = this.dirty.delete(appId);
      return changed || was ? 'emit-sync' : 'none';
    }
    if (changed || (this.firstSync && !this.seen.has(appId))) this.dirty.add(appId);
    if (!this.dirty.has(appId)) return 'none';
    const last = this.lastLoad.get(appId);
    return last === undefined || now - last >= this.throttleMs ? 'load' : 'none';
  }

  /** Báo kết quả sau khi làm hiệu ứng 'load'. Lỗi ⇒ vẫn đặt thời điểm (không vòng lặp), giữ bẩn. */
  loadFinished(now: number, appId: string, ok: boolean): void {
    this.lastLoad.set(appId, now);
    this.seen.add(appId);
    if (ok) this.dirty.delete(appId);
  }
}
