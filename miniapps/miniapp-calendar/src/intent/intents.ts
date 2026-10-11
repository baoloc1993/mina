// Intent của Lịch. Shell đã kiểm schema (ajv); ở đây kiểm lại tối thiểu vì dữ liệu đến từ app khác.
import { isLocal } from '../recur/dates';
import { UUID_RE } from '../sdk';
import type { ReminderPayload } from '../data/repo';

export const NOTE_APP = 'vn.app.note';

export type ParsedIntent =
  | { kind: 'reminder.create'; payload: ReminderPayload }
  | { kind: 'event.open'; eventId: string }
  | { kind: 'notification.open'; eventId: string; occDate: string }
  | { kind: 'unknown' };

export function parseIntent(type: string, payload: unknown): ParsedIntent {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (type === 'calendar.reminder.create') {
    const { id, title, at, ref } = p;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return { kind: 'unknown' };
    if (typeof title !== 'string' || !title.trim() || title.length > 200) return { kind: 'unknown' };
    if (!(typeof at === 'number' && Number.isFinite(at) && at >= 946_684_800_000 && at <= 4_102_444_800_000) && !isLocal(at)) return { kind: 'unknown' };
    const out: ReminderPayload = { id, title: title.trim(), at: at as string | number };
    if (ref && typeof ref === 'object') {
      const r = ref as Record<string, unknown>;
      if (typeof r.app === 'string' && r.app && r.app.length <= 64 && typeof r.id === 'string' && r.id && r.id.length <= 64) out.ref = { app: r.app, id: r.id };
    }
    return { kind: 'reminder.create', payload: out };
  }
  if (type === 'calendar.event.open') {
    return typeof p.eventId === 'string' && UUID_RE.test(p.eventId) ? { kind: 'event.open', eventId: p.eventId } : { kind: 'unknown' };
  }
  if (type === 'platform.notification.open') {
    const ref = typeof p.ref === 'string' ? p.ref : '';
    const [eventId, occDate] = ref.split('|');
    return UUID_RE.test(eventId ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(occDate ?? '') ? { kind: 'notification.open', eventId, occDate } : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}
