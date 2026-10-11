import type { EventRow, OverrideRow } from '../src/recur/model';
import { fixedOffsetZone } from '../src/recur/zone';
import type { Env } from '../src/recur/occurrences';

export const VN = fixedOffsetZone(420, 'UTC+7');
export const JP = fixedOffsetZone(540, 'UTC+9');
export const envAt = (local: string, zone = VN): Env => ({ zone, now: zone.localToMs(local) });

let n = 0;
export const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

export function ev(p: Partial<EventRow> & { start_local: string }): EventRow {
  return {
    id: uid(), kind: 'event', title: 'Mục', all_day: 0, end_local: null, fixed: 0, start_ms: null, end_ms: null, tz: null,
    repeat_unit: null, repeat_every: 1, repeat_cal: 'solar', repeat_until: null, lunar_month: null, lunar_day: null, alert_min: 0,
    done_at_ms: null, src_app: null, src_id: null, ...p,
  };
}
export const ov = (event_id: string, occ_date: string, action: OverrideRow['action'], patch: object = {}, id = uid()): OverrideRow => ({ id, event_id, occ_date, action, patch: JSON.stringify(patch) });
