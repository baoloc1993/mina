// Vòng đời nhiều mini app (CAP-RT-01, AC-14): tối đa N WebView sống (kể cả app đang hiện), LRU theo lần hiện gần nhất.
// App thứ N+1 mở ⇒ app cũ nhất phải nhận `suspend` (≤ 500 ms lưu trạng thái) rồi bị huỷ. THUẦN TS.
export const MAX_LIVE = 3;
export const SUSPEND_ACK_MS = 500;

export class LiveSet {
  /** Cũ nhất trước. */
  live: string[] = [];
  foreground: string | null = null;
  constructor(private max = MAX_LIVE) {}

  /**
   * Đưa app lên hiện. Trả `resumed` = app đã sống từ trước (cần gửi `resume`),
   * `evict` = app cần suspend rồi huỷ (không bao giờ là app vừa mở).
   */
  open(appId: string): { resumed: boolean; evict: string[] } {
    const resumed = this.live.includes(appId);
    this.live = this.live.filter((a) => a !== appId);
    this.live.push(appId);
    this.foreground = appId;
    const evict: string[] = [];
    // `evict` chỉ gợi ý; app vẫn nằm trong `live` tới khi gọi `remove` (đang chờ ack suspend).
    const over = this.live.length - this.max;
    for (let i = 0; i < over; i++) evict.push(this.live[i]);
    return { resumed, evict };
  }

  /** Nạp nền (intent create cho app chưa chạy): sống nhưng không hiện, coi là MỚI NHẤT trừ app đang hiện. */
  openBackground(appId: string): { evict: string[] } {
    if (this.live.includes(appId)) return { evict: [] };
    const fg = this.foreground;
    this.live = this.live.filter((a) => a !== fg);
    this.live.push(appId);
    if (fg) this.live.push(fg);
    const over = this.live.length - this.max;
    const evict: string[] = [];
    for (let i = 0; i < over; i++) if (this.live[i] !== appId) evict.push(this.live[i]);
    return { evict };
  }

  closeForeground(): void {
    this.foreground = null;
  }

  remove(appId: string): void {
    this.live = this.live.filter((a) => a !== appId);
    if (this.foreground === appId) this.foreground = null;
  }
}
