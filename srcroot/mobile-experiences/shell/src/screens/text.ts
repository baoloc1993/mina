// Chuỗi dựng từ dữ liệu cho các màn (thuần TS — test được).
import { formatDate } from '../ui/format';
import type { RejectionRow } from '../runtime/types';

export function rejectionTitle(r: RejectionRow, appName: string): string {
  const parts = [appName, r.table, r.op].filter((x): x is string => !!x);
  return parts.join(' · ');
}

export function planLine(plan: { plan: string; max_apps: number | null; until: string | null } | null): string {
  if (!plan) return 'Gói: chưa xác minh';
  const limit = plan.max_apps === null ? 'không giới hạn app' : `tối đa ${plan.max_apps} app`;
  const until = plan.until ? ` · đến ${formatDate(plan.until)}` : '';
  return `Gói: ${plan.plan} — ${limit}${until}`;
}

export function readOnlyBannerText(reason: string): string {
  if (reason === 'clock-rolled-back') return 'Chỉ đọc: đồng hồ máy bị chỉnh lùi — cần mạng để xác minh lại';
  return 'Chỉ đọc: gói đã quá ân hạn — cần mạng để xác minh lại';
}
