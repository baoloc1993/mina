// Kiểu dữ liệu Lịch — khớp migration 001_init.sql và ARCHITECTURE.md §6 (`events`, `event_overrides`).
import type { Ymd } from './dates';

export type Kind = 'event' | 'reminder';
export type RepeatUnit = 'day' | 'week' | 'month' | 'year';
export type OverrideAction = 'skip' | 'edit' | 'done' | 'snooze';

export interface EventRow {
  id: string;
  kind: Kind;
  title: string;
  all_day: number;
  /** Giờ treo `YYYY-MM-DDTHH:mm` (cả ngày: `YYYY-MM-DD`). Với `fixed = 1`: giờ đồng hồ trong múi giờ `tz`. */
  start_local: string;
  end_local: string | null;
  fixed: number;
  start_ms: number | null;
  end_ms: number | null;
  tz: string | null;
  repeat_unit: RepeatUnit | null;
  repeat_every: number;
  repeat_cal: 'solar' | 'lunar';
  repeat_until: Ymd | null;
  lunar_month: number | null;
  lunar_day: number | null;
  alert_min: number;
  done_at_ms: number | null;
  src_app: string | null;
  src_id: string | null;
}

export interface OverrideRow {
  id: string;
  event_id: string;
  occ_date: Ymd;
  action: OverrideAction;
  /** JSON. edit: các cột đè; snooze: {until_local}; done: {at_ms}. */
  patch: string;
}

export interface EditPatch {
  title?: string;
  start_local?: string;
  end_local?: string | null;
  alert_min?: number;
}

export const ALERT_CHOICES = [0, 10, 60, 1440] as const;
export const ALERT_LABEL: Record<number, string> = { 0: 'Đúng giờ', 10: '10 phút trước', 60: '1 giờ trước', 1440: '1 ngày trước' };
export const UNIT_LABEL: Record<RepeatUnit, string> = { day: 'ngày', week: 'tuần', month: 'tháng', year: 'năm' };
export const ALL_DAY_NOTIFY_TIME = '07:00';
