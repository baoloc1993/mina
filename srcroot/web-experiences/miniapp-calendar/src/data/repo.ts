// Truy cập dữ liệu Lịch qua `window.miniapp` (SDK 0.1.1). Bảng viết tên ngắn (events, event_overrides); bridge đổi tiền tố, tự lọc dòng
// đã xoá mềm và viết DELETE thành xoá mềm. Thuần logic — không đụng DOM nên test được trên mock SDK.
import { splitLocal, type Ymd } from '../recur/dates';
import type { EditPatch, EventRow, OverrideAction, OverrideRow } from '../recur/model';
import { newId, type Sdk } from '../sdk';

const COLS =
  'id, kind, title, all_day, start_local, end_local, fixed, start_ms, end_ms, tz, repeat_unit, repeat_every, repeat_cal, repeat_until, lunar_month, lunar_day, alert_min, done_at_ms, src_app, src_id';
const OV_COLS = 'id, event_id, occ_date, action, patch';

export async function listEvents(sdk: Sdk): Promise<EventRow[]> {
  return (await sdk.db.query<EventRow>(`SELECT ${COLS} FROM events ORDER BY start_local, id`, [])) as EventRow[];
}

export async function listOverrides(sdk: Sdk): Promise<OverrideRow[]> {
  return (await sdk.db.query<OverrideRow>(`SELECT ${OV_COLS} FROM event_overrides ORDER BY id`, [])) as OverrideRow[];
}

export async function loadAll(sdk: Sdk): Promise<{ events: EventRow[]; overrides: OverrideRow[] }> {
  const [events, overrides] = await Promise.all([listEvents(sdk), listOverrides(sdk)]);
  const alive = new Set(events.map((e) => e.id));
  return { events, overrides: overrides.filter((o) => alive.has(o.event_id)) }; // ngoại lệ mồ côi (mục cha đã xoá) bị bỏ qua
}

export async function getEvent(sdk: Sdk, id: string, includeDeleted = false): Promise<EventRow | null> {
  const rows = (await sdk.db.query<EventRow>(`SELECT ${COLS} FROM events WHERE id = ?`, [id], { includeDeleted })) as EventRow[];
  return rows[0] ?? null;
}

const FIELDS: (keyof EventRow)[] = [
  'kind', 'title', 'all_day', 'start_local', 'end_local', 'fixed', 'start_ms', 'end_ms', 'tz', 'repeat_unit', 'repeat_every',
  'repeat_cal', 'repeat_until', 'lunar_month', 'lunar_day', 'alert_min', 'done_at_ms', 'src_app', 'src_id',
];
const vals = (e: EventRow) => FIELDS.map((f) => (e[f] === undefined ? null : (e[f] as string | number | null)));

export async function insertEvent(sdk: Sdk, e: EventRow): Promise<void> {
  await sdk.db.execute(`INSERT INTO events (id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`, [e.id, ...vals(e)]);
}

/** Sửa "tất cả": PATCH các cột đổi. Đổi quy tắc / giờ bắt đầu làm `occ_date` cũ mất nghĩa → xoá mềm ngoại lệ cũ (ARCHITECTURE §6). */
export async function updateEvent(sdk: Sdk, before: EventRow, after: EventRow): Promise<void> {
  const changed = FIELDS.filter((f) => before[f] !== after[f]);
  const statements: { sql: string; params: (string | number | null)[] }[] = [];
  if (changed.length) {
    statements.push({ sql: `UPDATE events SET ${changed.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, params: [...changed.map((f) => (after[f] ?? null) as string | number | null), after.id] });
  }
  const ruleChanged = (['repeat_unit', 'repeat_cal', 'repeat_every', 'lunar_month', 'lunar_day'] as const).some((f) => before[f] !== after[f]) || splitLocal(before.start_local).date !== splitLocal(after.start_local).date;
  if (ruleChanged) statements.push({ sql: 'DELETE FROM event_overrides WHERE event_id = ?', params: [after.id] });
  if (statements.length) await sdk.db.transaction(statements);
}

/** Xoá "tất cả": xoá mềm mục và mọi ngoại lệ của nó. */
export async function removeEvent(sdk: Sdk, id: string): Promise<void> {
  await sdk.db.transaction([
    { sql: 'DELETE FROM event_overrides WHERE event_id = ?', params: [id] },
    { sql: 'DELETE FROM events WHERE id = ?', params: [id] },
  ]);
}

export async function setDoneAt(sdk: Sdk, id: string, at: number | null): Promise<void> {
  await sdk.db.execute('UPDATE events SET done_at_ms = ? WHERE id = ?', [at, id]);
}

/** Ghi / thay một ngoại lệ (event_id, occ_date, action). Có sẵn dòng ở máy này thì sửa dòng id nhỏ nhất, không thì chèn dòng mới. */
export async function putOverride(sdk: Sdk, eventId: string, occDate: Ymd, action: OverrideAction, patch: object = {}): Promise<void> {
  const rows = (await sdk.db.query<{ id: string }>('SELECT id FROM event_overrides WHERE event_id = ? AND occ_date = ? AND action = ? ORDER BY id', [eventId, occDate, action])) as { id: string }[];
  const json = JSON.stringify(patch);
  if (rows[0]) await sdk.db.execute('UPDATE event_overrides SET patch = ? WHERE id = ?', [json, rows[0].id]);
  else await sdk.db.execute('INSERT INTO event_overrides (id, event_id, occ_date, action, patch) VALUES (?, ?, ?, ?, ?)', [newId(), eventId, occDate, action, json]);
}

/** Bỏ ngoại lệ (xoá mềm mọi dòng trùng) — "bỏ đánh dấu xong", "bỏ hoãn". */
export async function clearOverride(sdk: Sdk, eventId: string, occDate: Ymd, action: OverrideAction): Promise<void> {
  await sdk.db.execute('DELETE FROM event_overrides WHERE event_id = ? AND occ_date = ? AND action = ?', [eventId, occDate, action]);
}

export async function editThisOnly(sdk: Sdk, eventId: string, occDate: Ymd, patch: EditPatch): Promise<void> {
  await putOverride(sdk, eventId, occDate, 'edit', patch);
}

export type CreateReminderResult = 'created' | 'exists';

export interface ReminderPayload {
  id: string;
  title: string;
  at: string | number;
  ref?: { app: string; id: string };
}

/**
 * Intent `calendar.reminder.create` (AC-4): tạo lời nhắc đúng `id` bên gửi sinh. Gửi lại cùng id → không tạo trùng, kể cả khi mục
 * đã bị xoá mềm (xoá rồi thì không hồi sinh).
 */
export async function createReminderFromIntent(sdk: Sdk, p: ReminderPayload, deviceTz: string, wallOf: (ms: number) => string): Promise<CreateReminderResult> {
  if (await getEvent(sdk, p.id, true)) return 'exists';
  const fixed = typeof p.at === 'number';
  const start = fixed ? wallOf(p.at as number) : (p.at as string);
  const row: EventRow = {
    id: p.id, kind: 'reminder', title: p.title.slice(0, 200), all_day: 0, start_local: start, end_local: null,
    fixed: fixed ? 1 : 0, start_ms: fixed ? (p.at as number) : null, end_ms: null, tz: fixed ? deviceTz : null,
    repeat_unit: null, repeat_every: 1, repeat_cal: 'solar', repeat_until: null, lunar_month: null, lunar_day: null,
    alert_min: 0, done_at_ms: null, src_app: p.ref?.app ?? null, src_id: p.ref?.id ?? null,
  };
  await insertEvent(sdk, row);
  return 'created';
}
