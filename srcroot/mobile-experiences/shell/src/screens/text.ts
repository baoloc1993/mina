// Chuỗi dựng từ dữ liệu cho các màn (thuần TS — test được).
import { formatDate } from '../ui/format';
import type { RejectionRow } from '../runtime/types';

/** Dòng từ chối do shell tự ghi (cập nhật app lỗi) ⇒ "<app> · cập nhật <phiên bản>"; dòng server ⇒ "<app> · <bảng> · <thao tác>". */
export function rejectionTitle(r: RejectionRow, appName: string, version?: string | null): string {
  if (r.source === 'local') return `${appName} · cập nhật${version ? ` ${version}` : ''}`;
  const parts = [appName, r.table, r.op].filter((x): x is string => !!x);
  return parts.join(' · ');
}

/** Banner S2: toàn bộ là lỗi cục bộ (app không cập nhật được) ⇒ nói theo app, không nói "thay đổi". */
export function rejectionBannerText(count: number, rows: readonly RejectionRow[]): string {
  if (rows.length > 0 && rows.every((r) => r.source === 'local')) return `${rows.length} app không cập nhật được`;
  return `${count} thay đổi bị từ chối khi đồng bộ`;
}

export function planLine(plan: { plan: string; max_apps: number | null; until: string | null } | null): string {
  if (!plan) return 'Chưa xác minh gói';
  const limit = plan.max_apps === null ? 'Không giới hạn app' : `Tối đa ${plan.max_apps} app`;
  const until = plan.until ? ` · đến ${formatDate(plan.until)}` : '';
  return `${limit}${until}`;
}

export function readOnlyBannerText(reason: string): string {
  if (reason === 'clock-rolled-back') return 'Chỉ đọc: đồng hồ máy bị chỉnh lùi — cần mạng để xác minh lại';
  return 'Chỉ đọc: gói đã quá ân hạn — cần mạng để xác minh lại';
}
