// Logic thuần của "domain do người dùng cho phép".
// Runtime chỉ làm hiệu ứng (đọc/ghi bảng core_net_grants, hộp thoại); mọi quyết định "host nào cho vào whitelist" nằm ở đây để kiểm bằng Jest.
import { isValidHost } from '../bridge/netGuard';

export interface GrantRow {
  app_id: string;
  host: string;
  created_at: string | null;
}

/** Một grant sống (gộp các dòng trùng `(app_id, host)` do hai máy cùng cho phép offline — lấy `created_at` sớm nhất). */
export interface NetGrantItem {
  appId: string;
  host: string;
  since: string;
}

/** Từ các dòng `core_net_grants` còn sống → danh sách đã khử trùng, sắp theo thời điểm cho phép. */
export function liveGrants(rows: readonly GrantRow[]): NetGrantItem[] {
  const seen = new Map<string, NetGrantItem>();
  for (const r of rows) {
    if (typeof r.app_id !== 'string' || !isValidHost(r.host)) continue; // dòng hỏng không bao giờ mở cửa
    const key = `${r.app_id}\u0000${r.host}`;
    const since = r.created_at ?? '';
    const prev = seen.get(key);
    if (!prev || (since && since < prev.since)) seen.set(key, { appId: r.app_id, host: r.host, since });
  }
  return [...seen.values()].sort((a, b) => a.since.localeCompare(b.since) || a.host.localeCompare(b.host));
}

/** `config.network` của app: chỉ nhận host hợp lệ (khoá lạ / rác bị bỏ, không ném). */
export function configNetwork(config: Record<string, unknown> | null | undefined): string[] {
  const n = config?.network;
  if (!Array.isArray(n)) return [];
  return [...new Set(n.filter((h): h is string => isValidHost(h)))];
}

/** Cấu hình app từ `catalog.apps[].config`: chỉ nhận object thuần, còn lại → `{}` (app chưa có cấu hình). */
export function configOf(config: unknown): Record<string, unknown> {
  return config !== null && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
}

/** Host mở thêm cho một app NGOÀI `manifest.network`: `config.network` ∪ grant sống của đúng app đó (app khác không hưởng). */
export function extraHostsOf(appId: string, config: Record<string, unknown> | null | undefined, grants: readonly NetGrantItem[]): string[] {
  const fromGrants = grants.filter((g) => g.appId === appId).map((g) => g.host);
  return [...new Set([...configNetwork(config), ...fromGrants])];
}

export interface HostGroups {
  /** Theo manifest — không thu hồi được. */
  manifest: string[];
  /** Theo cấu hình server — không thu hồi được. */
  config: string[];
  /** Người dùng đã cho phép — có nút Thu hồi. */
  user: NetGrantItem[];
}

/** S4 "Trang app được phép truy cập": ba nhóm, mỗi host chỉ xuất hiện ở nhóm đầu tiên chứa nó (manifest > cấu hình > người dùng). */
export function hostGroups(manifestNetwork: readonly string[] | undefined, config: Record<string, unknown> | null | undefined, grants: readonly NetGrantItem[], appId: string): HostGroups {
  const manifest = [...new Set((manifestNetwork ?? []).map((h) => h.toLowerCase()))];
  const taken = new Set(manifest);
  const cfg = configNetwork(config).filter((h) => !taken.has(h));
  cfg.forEach((h) => taken.add(h));
  const user = grants.filter((g) => g.appId === appId && !taken.has(g.host));
  return { manifest, config: cfg, user };
}

/** Nhãn phụ của một host ở S4. */
export function hostSubtitle(kind: 'manifest' | 'config' | 'user', since?: string): string {
  if (kind === 'manifest') return 'theo app';
  if (kind === 'config') return 'theo cấu hình';
  const d = since ? new Date(since) : null;
  if (!d || Number.isNaN(d.getTime())) return 'bạn cho phép';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `bạn cho phép ${dd}/${mm}`;
}
