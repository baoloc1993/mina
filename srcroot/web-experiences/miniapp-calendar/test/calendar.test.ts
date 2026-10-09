// AC-1..AC-4, AC-6 trên BRIDGE THẬT của shell (scope/SQL guard, chỉ đọc, intent) + đồng hồ giả + hai "máy".
import Ajv from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';
import { clearOverride, createReminderFromIntent, getEvent, insertEvent, loadAll, putOverride, removeEvent, setDoneAt, updateEvent } from '../src/data/repo';
import { parseIntent } from '../src/intent/intents';
import { reconcile, reconcileOnce } from '../src/notify/reconcile';
import { occurrencesAll, type Env } from '../src/recur/occurrences';
import { deviceZone, fixedOffsetZone } from '../src/recur/zone';
import { errCode } from '../src/sdk';
import { ev, uid } from './fixtures';
import { machine, manifest, noteManifest, push, sync2, type Machine } from './harness';

const ZONE = fixedOffsetZone(420, 'UTC+7');
const at = (local: string) => ZONE.localToMs(local);
const T0 = at('2026-10-08T23:00'); // 08/10 23:00 giờ VN
const envOf = (m: Machine): Env => ({ zone: ZONE, now: m.clock.now });
const open: Machine[] = [];
const mk = () => {
  const m = machine(T0);
  open.push(m);
  return m;
};
afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe('AC-1: sự kiện và lời nhắc offline, lưu qua bridge thật', () => {
  it('tạo / sửa / xoá lúc offline, đọc lại đúng; kill app (đọc lại từ DB) vẫn còn', async () => {
    const m = mk();
    m.setNet('offline');
    const e = ev({ kind: 'reminder', title: 'Uống thuốc', start_local: '2026-10-09T07:00', repeat_unit: 'day' });
    await insertEvent(m.sdk, e);
    let all = await loadAll(m.sdk);
    expect(all.events).toHaveLength(1);
    expect(all.events[0]).toMatchObject({ title: 'Uống thuốc', repeat_unit: 'day', repeat_every: 1, repeat_cal: 'solar' });
    await updateEvent(m.sdk, e, { ...e, title: 'Uống thuốc huyết áp' });
    expect((await getEvent(m.sdk, e.id))!.title).toBe('Uống thuốc huyết áp');
    await removeEvent(m.sdk, e.id);
    all = await loadAll(m.sdk);
    expect(all.events).toHaveLength(0);
    expect(await getEvent(m.sdk, e.id)).toBeNull();
    expect(await getEvent(m.sdk, e.id, true)).not.toBeNull(); // xoá mềm, còn dòng để đồng bộ
  });

  it('"Chỉ lần này": ngoại lệ là dòng riêng, không nhân bản mục; đổi quy tắc "tất cả" thì dọn ngoại lệ', async () => {
    const m = mk();
    const e = ev({ title: 'Họp', start_local: '2026-10-12T09:00', repeat_unit: 'week' });
    await insertEvent(m.sdk, e);
    await putOverride(m.sdk, e.id, '2026-10-19', 'edit', { start_local: '2026-10-19T10:00' });
    await putOverride(m.sdk, e.id, '2026-10-19', 'edit', { start_local: '2026-10-19T11:00' }); // sửa lần nữa = cùng một dòng
    await putOverride(m.sdk, e.id, '2026-10-26', 'skip');
    const rows = m.db.all(`SELECT * FROM app_vn_app_calendar_event_overrides WHERE deleted_at IS NULL`, []) as unknown[];
    expect(rows).toHaveLength(2);
    expect((await loadAll(m.sdk)).events).toHaveLength(1);
    const os = occurrencesAll((await loadAll(m.sdk)).events, (await loadAll(m.sdk)).overrides, '2026-10-12', '2026-10-31', envOf(m));
    expect(os.map((o) => o.startLocal)).toEqual(['2026-10-12T09:00', '2026-10-19T11:00']);
    await updateEvent(m.sdk, e, { ...e, repeat_unit: 'day' }); // đổi quy tắc
    expect((await loadAll(m.sdk)).overrides).toHaveLength(0);
  });

  it('xong / bỏ xong / hoãn', async () => {
    const m = mk();
    const e = ev({ kind: 'reminder', title: 'Gọi bảo hiểm', start_local: '2026-10-09T10:00' });
    await insertEvent(m.sdk, e);
    await setDoneAt(m.sdk, e.id, 123);
    let o = occurrencesAll((await loadAll(m.sdk)).events, [], '2026-10-09', '2026-10-09', envOf(m))[0];
    expect(o.done).toBe(true);
    await setDoneAt(m.sdk, e.id, null);
    await putOverride(m.sdk, e.id, '2026-10-09', 'snooze', { until_local: '2026-10-09T11:00' });
    const all = await loadAll(m.sdk);
    o = occurrencesAll(all.events, all.overrides, '2026-10-09', '2026-10-09', envOf(m))[0];
    expect(o.done).toBe(false);
    expect(o.snoozeUntilMs).toBe(at('2026-10-09T11:00'));
    await clearOverride(m.sdk, e.id, '2026-10-09', 'snooze');
    expect((await loadAll(m.sdk)).overrides).toHaveLength(0);
  });

  it('chỉ đọc: mọi ghi bị bridge từ chối READ_ONLY, dữ liệu còn nguyên', async () => {
    const m = mk();
    const e = ev({ title: 'Còn nguyên', start_local: '2026-10-09T07:00' });
    await insertEvent(m.sdk, e);
    m.setNet('ro');
    await expect(insertEvent(m.sdk, ev({ title: 'Mới', start_local: '2026-10-09T08:00' }))).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(setDoneAt(m.sdk, e.id, 1)).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect((await loadAll(m.sdk)).events).toHaveLength(1);
  });

  it('bridge không cho đọc bảng của app khác / SQL ngoài phạm vi', async () => {
    const m = mk();
    await expect(m.sdk.db.query('SELECT * FROM notes', [])).rejects.toMatchObject({ code: expect.stringMatching(/SQL_REJECTED|SCOPE_DENIED/) });
  });
});

describe('AC-2: thông báo đúng giờ, offline, bấm mở đúng mục', () => {
  it('tắt mạng, đẩy đồng hồ tới 07:00 → kêu đúng giờ, ref = eventId|ngày', async () => {
    const m = mk();
    m.setNet('offline');
    const e = ev({ kind: 'reminder', title: 'Uống thuốc', start_local: '2026-10-09T07:00', repeat_unit: 'day' });
    await insertEvent(m.sdk, e);
    const r = await reconcileOnce(m.sdk, envOf(m));
    expect(r).toMatchObject({ scheduled: 40, denied: false });
    const first = [...m.notes.values()].sort((a, b) => a.at - b.at)[0];
    expect(first.at).toBe(at('2026-10-09T07:00'));
    expect(first.ref).toBe(`${e.id}|2026-10-09`);
    m.advance(at('2026-10-09T06:59') - m.clock.now);
    expect(m.advance(0).length).toBe(0);
    const out = m.advance(60_000); // tới 07:00
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Uống thuốc');
    expect(parseIntent('platform.notification.open', { ref: out[0].ref })).toEqual({ kind: 'notification.open', eventId: e.id, occDate: '2026-10-09' });
  });

  it('lời nhắc đặt giờ đã qua → kêu ngay một lần; reconcile lặp lại không kêu lại', async () => {
    const m = mk();
    const e = ev({ kind: 'reminder', title: 'Đã trễ', start_local: '2026-10-08T20:00' });
    await insertEvent(m.sdk, e);
    const key = `${e.id}|2026-10-08`;
    await reconcileOnce(m.sdk, envOf(m), new Set([key]));
    expect(m.notes.get(key)!.at).toBe(m.clock.now);
    expect(m.advance(1000)).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      m.advance(60_000);
      const r = await reconcileOnce(m.sdk, envOf(m));
      expect(r.scheduled).toBe(0);
    }
    expect(m.fired).toHaveLength(1);
  });

  it('quyền thông báo bị từ chối: mục vẫn lưu, báo denied, cấp quyền sau thì tự đặt đủ', async () => {
    const m = mk();
    m.denyNotifications(true);
    const e = ev({ kind: 'reminder', title: 'Nhắc', start_local: '2026-10-09T07:00' });
    await insertEvent(m.sdk, e);
    const r = await reconcile(m.sdk, { env: envOf(m) });
    expect(r.denied).toBe(true);
    expect(m.notes.size).toBe(0);
    expect((await loadAll(m.sdk)).events).toHaveLength(1);
    m.denyNotifications(false);
    expect((await reconcile(m.sdk, { env: envOf(m) })).scheduled).toBe(1);
  });

  it('chỉ đọc: đối chiếu thông báo VẪN chạy (notify.* không phải ghi dữ liệu), nhưng ghi dữ liệu bị từ chối', async () => {
    const m = mk();
    const e = ev({ kind: 'reminder', title: 'Nhắc', start_local: '2026-10-09T07:00' });
    await insertEvent(m.sdk, e);
    m.setNet('ro');
    expect((await reconcileOnce(m.sdk, envOf(m))).scheduled).toBe(1);
    await expect(setDoneAt(m.sdk, e.id, 1)).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(m.notes.size).toBe(1);
  });

  it('title 200 ký tự lưu được và vẫn đặt được thông báo (cắt còn 100)', async () => {
    const m = mk();
    await insertEvent(m.sdk, ev({ title: 'x'.repeat(200), start_local: '2026-10-09T09:00' }));
    const r = await reconcileOnce(m.sdk, envOf(m));
    expect(r.failed).toBe(0);
    expect([...m.notes.values()][0].title).toHaveLength(100);
  });
});

describe('AC-3: nhiều máy, đặt lại, giới hạn', () => {
  it('máy A đánh dấu xong → sync → máy B đối chiếu và huỷ đúng lần đó; B offline thì còn nguyên', async () => {
    const a = mk();
    const b = mk();
    const e = ev({ kind: 'reminder', title: 'Uống thuốc', start_local: '2026-10-09T07:00', repeat_unit: 'day', repeat_until: '2026-10-12' });
    await insertEvent(a.sdk, e);
    push(a, b);
    await reconcileOnce(a.sdk, envOf(a));
    await reconcileOnce(b.sdk, envOf(b));
    expect(b.notes.size).toBe(4);
    await putOverride(a.sdk, e.id, '2026-10-09', 'done', { at_ms: a.clock.now });
    // B chưa nhận đồng bộ (offline) → vẫn kêu theo bản cũ
    expect((await reconcileOnce(b.sdk, envOf(b))).cancelled).toBe(0);
    expect(b.notes.has(`${e.id}|2026-10-09`)).toBe(true);
    // có mạng: sync, rồi shell nạp nền Lịch → đối chiếu
    push(a, b);
    const r = await reconcileOnce(b.sdk, envOf(b));
    expect(r.cancelled).toBe(1);
    expect(b.notes.has(`${e.id}|2026-10-09`)).toBe(false);
    expect(b.notes.size).toBe(3);
  });

  it('hai máy cùng đánh dấu xong cùng lần: hai dòng ngoại lệ, hội tụ, không lỗi', async () => {
    const a = mk();
    const b = mk();
    const e = ev({ kind: 'reminder', title: 'X', start_local: '2026-10-09T07:00', repeat_unit: 'day' });
    await insertEvent(a.sdk, e);
    push(a, b);
    await putOverride(a.sdk, e.id, '2026-10-09', 'done', { at_ms: 1 });
    await putOverride(b.sdk, e.id, '2026-10-09', 'done', { at_ms: 2 });
    sync2(a, b);
    for (const m of [a, b]) {
      const all = await loadAll(m.sdk);
      expect(all.overrides.filter((o) => o.action === 'done')).toHaveLength(2);
      const o = occurrencesAll(all.events, all.overrides, '2026-10-09', '2026-10-09', envOf(m))[0];
      expect(o.done).toBe(true);
    }
  });

  it('A đổi giờ một lần → B (sau sync) đặt lại đúng giờ mới', async () => {
    const a = mk();
    const b = mk();
    const e = ev({ kind: 'reminder', title: 'X', start_local: '2026-10-09T07:00', repeat_unit: 'day', repeat_until: '2026-10-10' });
    await insertEvent(a.sdk, e);
    push(a, b);
    await reconcileOnce(b.sdk, envOf(b));
    await putOverride(a.sdk, e.id, '2026-10-10', 'edit', { start_local: '2026-10-10T09:15' });
    push(a, b);
    await reconcileOnce(b.sdk, envOf(b));
    expect(b.notes.get(`${e.id}|2026-10-10`)!.at).toBe(at('2026-10-10T09:15'));
  });

  it('khởi động lại máy: danh sách thông báo mất → mở app đặt lại đủ', async () => {
    const m = mk();
    await insertEvent(m.sdk, ev({ kind: 'reminder', title: 'X', start_local: '2026-10-09T07:00', repeat_unit: 'day' }));
    await reconcileOnce(m.sdk, envOf(m));
    const n = m.notes.size;
    m.notes.clear(); // force-stop / khởi động lại
    expect((await reconcileOnce(m.sdk, envOf(m))).scheduled).toBe(n);
  });

  it('bộ lặp ngày 400 lần → notify.list có đúng 40 cái ĐẦU; shell (giả lập) ≤ 50', async () => {
    const m = mk();
    const e = ev({ kind: 'reminder', title: 'Chuỗi thử 400 ngày', start_local: '2026-10-09T09:00', repeat_unit: 'day', repeat_until: '2027-11-12' });
    await insertEvent(m.sdk, e);
    await reconcileOnce(m.sdk, envOf(m));
    const list = (await m.sdk.notify.list()) as { id: string; at: number }[];
    expect(list).toHaveLength(40);
    expect(list[0].id).toBe(`${e.id}|2026-10-09`);
    expect(list[39].id).toBe(`${e.id}|2026-11-17`);
    // người dùng xong 10 lần đầu → cửa sổ trượt: vẫn 40 cái đầu của phần còn lại
    for (let d = 9; d < 19; d++) await putOverride(m.sdk, e.id, `2026-10-${String(d).padStart(2, '0')}`, 'done', { at_ms: 1 });
    await reconcileOnce(m.sdk, envOf(m));
    const after = (await m.sdk.notify.list()) as { id: string }[];
    expect(after).toHaveLength(40);
    expect(after[0].id).toBe(`${e.id}|2026-10-19`);
  });

  it('gọi reconcile chồng nhau không chạy song song và cho cùng kết quả', async () => {
    const m = mk();
    await insertEvent(m.sdk, ev({ kind: 'reminder', title: 'X', start_local: '2026-10-09T07:00' }));
    const env = envOf(m);
    const [r1, r2] = await Promise.all([reconcile(m.sdk, { env }), reconcile(m.sdk, { env })]);
    expect(m.notes.size).toBe(1);
    expect(r1.denied || r2.denied).toBe(false);
  });
});

describe('AC-4: calendar.reminder.create', () => {
  const ajv = new Ajv({ strict: false });
  const schemaOf = (type: string) => manifest.intents!.receives!.find((r) => r.type === type)!.schema;
  const check = (type: string, payload: unknown) => ajv.compile(schemaOf(type))(payload);
  const id = '11111111-1111-4111-8111-111111111111';

  it('schema: hợp lệ / sai (at chữ thường, thiếu id, thừa trường)', () => {
    expect(check('calendar.reminder.create', { id, title: 'Đi chợ', at: '2026-10-12T07:00', ref: { app: 'vn.app.note', id: 'abc' } })).toBe(true);
    expect(check('calendar.reminder.create', { id, title: 'Họp', at: 1760000000000 })).toBe(true);
    expect(check('calendar.reminder.create', { id, title: 'X', at: 'hôm nay' })).toBe(false);
    expect(check('calendar.reminder.create', { title: 'X', at: '2026-10-12T07:00' })).toBe(false);
    expect(check('calendar.reminder.create', { id, title: 'X', at: '2026-10-12T07:00', extra: 1 })).toBe(false);
    expect(check('calendar.reminder.create', { id, title: '', at: '2026-10-12T07:00' })).toBe(false);
    expect(check('calendar.event.open', { eventId: id })).toBe(true);
    expect(check('calendar.event.open', { eventId: 'xyz' })).toBe(false);
  });

  it('tạo đúng id, gửi lại không trùng, đã xoá thì không hồi sinh; ref lưu vào src_app/src_id', async () => {
    const m = mk();
    const p = parseIntent('calendar.reminder.create', { id, title: 'Đi chợ', at: '2026-10-09T17:30', ref: { app: 'vn.app.note', id: 'note-1' } });
    expect(p.kind).toBe('reminder.create');
    if (p.kind !== 'reminder.create') return;
    expect(await createReminderFromIntent(m.sdk, p.payload, 'Asia/Ho_Chi_Minh', (ms) => ZONE.msToLocal(ms))).toBe('created');
    expect(await createReminderFromIntent(m.sdk, p.payload, 'Asia/Ho_Chi_Minh', (ms) => ZONE.msToLocal(ms))).toBe('exists');
    const rows = (await loadAll(m.sdk)).events;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, kind: 'reminder', start_local: '2026-10-09T17:30', fixed: 0, src_app: 'vn.app.note', src_id: 'note-1' });
    await removeEvent(m.sdk, id);
    expect(await createReminderFromIntent(m.sdk, p.payload, 'Asia/Ho_Chi_Minh', (ms) => ZONE.msToLocal(ms))).toBe('exists');
    expect((await loadAll(m.sdk)).events).toHaveLength(0);
  });

  it('at là số → giờ cố định, ghi múi giờ máy; ref lạ vẫn tạo', async () => {
    const m = mk();
    const ms = at('2026-10-10T09:00');
    const p = parseIntent('calendar.reminder.create', { id, title: 'Họp online', at: ms, ref: { app: 'com.khac', id: 'q' } });
    if (p.kind !== 'reminder.create') throw new Error('parse');
    await createReminderFromIntent(m.sdk, p.payload, 'Asia/Ho_Chi_Minh', (x) => ZONE.msToLocal(x));
    expect((await getEvent(m.sdk, id))).toMatchObject({ fixed: 1, start_ms: ms, tz: 'Asia/Ho_Chi_Minh', start_local: '2026-10-10T09:00', src_app: 'com.khac' });
  });

  it('payload sai bị parse từ chối (phòng thủ lớp hai)', () => {
    expect(parseIntent('calendar.reminder.create', { id: 'x', title: 'a', at: '2026-10-12T07:00' }).kind).toBe('unknown');
    expect(parseIntent('calendar.reminder.create', { id, title: 'a', at: 'hôm nay' }).kind).toBe('unknown');
    expect(parseIntent('calendar.event.open', { eventId: 'x' }).kind).toBe('unknown');
    expect(parseIntent('lạ', {}).kind).toBe('unknown');
  });

  it('Lịch gửi note.open: Ghi chú đã cài → opened; chưa cài → INTENT_NO_HANDLER; app gửi không khai sends → SCOPE_DENIED', async () => {
    const m = mk();
    const noteId = '22222222-2222-4222-8222-222222222222';
    await expect(m.sdk.intent.send('note.open', { noteId }, { mode: 'open' })).resolves.toMatchObject({ status: 'opened' });
    expect(m.intents.at(-1)).toMatchObject({ type: 'note.open', to: 'vn.app.note', payload: { noteId } });
    m.noteInstalled = false;
    await expect(m.sdk.intent.send('note.open', { noteId }, { mode: 'open' })).rejects.toSatisfy((e) => errCode(e) === 'INTENT_NO_HANDLER');
    m.noteInstalled = true;
    await expect(m.sdk.intent.send('calendar.event.open', { eventId: id }, { mode: 'open' })).rejects.toSatisfy((e) => ['SCOPE_DENIED', 'INTENT_NO_HANDLER', 'INTENT_REJECTED'].includes(errCode(e)));
    await expect(m.sdk.intent.send('note.open', { noteId: 'sai' }, { mode: 'open' })).rejects.toMatchObject({ code: 'INTENT_REJECTED' });
  });
});

describe('AC-6: calendar.event.open', () => {
  it('parse id thật → event.open; getEvent id lạ / đã xoá → null (khuôn NOT_FOUND)', async () => {
    const m = mk();
    const e = ev({ title: 'X', start_local: '2026-10-09T09:00' });
    await insertEvent(m.sdk, e);
    expect(parseIntent('calendar.event.open', { eventId: e.id })).toEqual({ kind: 'event.open', eventId: e.id });
    expect(await getEvent(m.sdk, e.id)).not.toBeNull();
    expect(await getEvent(m.sdk, uid())).toBeNull();
    await removeEvent(m.sdk, e.id);
    expect(await getEvent(m.sdk, e.id)).toBeNull();
  });
});

describe('múi giờ máy', () => {
  it('đổi múi giờ: giờ treo đặt lại đúng 07:00 mới, giờ cố định giữ thời điểm', async () => {
    const m = mk();
    const hang = ev({ kind: 'reminder', title: 'Treo', start_local: '2026-10-10T07:00' });
    const fixed = ev({ title: 'Họp', start_local: '2026-10-10T09:00', fixed: 1, tz: 'Asia/Ho_Chi_Minh' });
    await insertEvent(m.sdk, hang);
    await insertEvent(m.sdk, fixed);
    await reconcileOnce(m.sdk, envOf(m));
    const before = new Map([...m.notes.values()].map((n) => [n.id, n.at]));
    const JP = fixedOffsetZone(540, 'UTC+9');
    await reconcileOnce(m.sdk, { zone: JP, now: m.clock.now });
    const after = new Map([...m.notes.values()].map((n) => [n.id, n.at]));
    expect(after.get(`${hang.id}|2026-10-10`)).toBe(JP.localToMs('2026-10-10T07:00'));
    expect(after.get(`${hang.id}|2026-10-10`)).not.toBe(before.get(`${hang.id}|2026-10-10`));
    expect(after.get(`${fixed.id}|2026-10-10`)).toBe(before.get(`${fixed.id}|2026-10-10`));
  });
  it('deviceZone dùng được (Date địa phương)', () => {
    const ms = deviceZone.localToMs('2026-10-10T07:00');
    expect(deviceZone.msToLocal(ms)).toBe('2026-10-10T07:00');
  });
});

void noteManifest;
