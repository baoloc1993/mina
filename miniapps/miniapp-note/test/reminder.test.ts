// AC-7 phía Ghi chú (0.2.0): "Nhắc tôi" → intent calendar.reminder.create / calendar.event.open + bảng nhớ note_reminders.
// Chạy trên bridge THẬT của shell (scope `intent.send`, `intents.sends`, kiểm schema bên nhận, READ_ONLY) + Lịch giả trong harness.
import Ajv from 'ajv';
import { afterEach, describe, expect, test } from 'vitest';
import { forgetReminder, listReminders, saveReminder } from '../src/data/reminders';
import { createNote, purgeExpired, trashNote, DAY_MS, TRASH_DAYS } from '../src/data/repo';
import { canRemind, defaultText, NO_CALENDAR, openInCalendar, sendReminder } from '../src/reminder/send';
import { formatShort, formatSummary, isPast, parseAt, quickOptions, toAt } from '../src/reminder/time';
import { newId } from '../src/sdk';
import { calendarManifest, closeAll, machine, manifest, PREFIX, type Machine } from './harness';

afterEach(closeAll);

const ajv = new Ajv({ allErrors: true, strict: false });
const calSchema = (type: string) => calendarManifest.intents!.receives!.find((r) => r.type === type)!.schema as object;
const rows = (m: Machine, withDeleted = true) => m.db.all(`SELECT * FROM ${PREFIX}_note_reminders${withDeleted ? '' : ' WHERE deleted_at IS NULL'}`, []) as Record<string, unknown>[];

describe('manifest 0.2.0', () => {
  test('khai scope intent.send, sends hai intent calendar.*, bảng note_reminders; migration 002 dựng bảng', () => {
    expect(manifest.version).toMatch(/^0\.2\.\d+$/); // 0.2.x: cùng hợp đồng (0.2.1 sửa theo dogfood vòng 5)
    expect(manifest.scopes).toContain('intent.send');
    expect(manifest.intents!.sends).toEqual([
      { type: 'calendar.reminder.create', version: '1' },
      { type: 'calendar.event.open', version: '1' },
    ]);
    expect(manifest.tables).toContain('note_reminders');
    expect(manifest.intents!.receives!.map((r) => r.type)).toEqual(['note.create', 'note.open']); // phần nhận không đổi
    const m = machine();
    expect(rows(m)).toEqual([]);
  });
});

describe('gửi calendar.reminder.create', () => {
  test('payload đúng schema Lịch (ajv), mode create, ref về note; handled ⇒ ghi note_reminders cùng id', async () => {
    const m = machine();
    const noteId = await createNote(m.sdk, newId(), 'Danh sách đi chợ');
    const r = await sendReminder(m.sdk, { noteId, text: 'Danh sách đi chợ', at: '2026-10-12T07:00' });
    expect(r.ok).toBe(true);
    expect(m.calendar.delivered).toHaveLength(1);
    const msg = m.calendar.delivered[0];
    expect(msg).toMatchObject({ type: 'calendar.reminder.create', version: '1', mode: 'create', to: 'vn.app.calendar' });
    const p = msg.payload as { id: string; title: string; at: string; ref: { app: string; id: string } };
    expect(ajv.compile(calSchema('calendar.reminder.create'))(p)).toBe(true);
    expect(p).toEqual({ id: (r as { id: string }).id, title: 'Danh sách đi chợ', at: '2026-10-12T07:00', ref: { app: 'vn.app.note', id: noteId } });
    const list = await listReminders(m.sdk, noteId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: p.id, note_id: noteId, at_local: '2026-10-12T07:00', title: 'Danh sách đi chợ' });
  });

  test('queued cũng ghi dòng nhớ', async () => {
    const m = machine();
    m.calendar.outcome = 'queued';
    const noteId = await createNote(m.sdk);
    const r = await sendReminder(m.sdk, { noteId, text: 'x', at: '2026-10-12T07:00' });
    expect(r).toMatchObject({ ok: true, status: 'queued' });
    expect(await listReminders(m.sdk, noteId)).toHaveLength(1);
  });

  test('Lịch chưa cài ⇒ INTENT_NO_HANDLER: banner, KHÔNG ghi dòng nào', async () => {
    const m = machine();
    m.calendar.installed = false;
    const noteId = await createNote(m.sdk);
    const r = await sendReminder(m.sdk, { noteId, text: 'x', at: '2026-10-12T07:00' });
    expect(r).toEqual({ ok: false, reason: 'NO_HANDLER', message: NO_CALENDAR });
    expect(r.ok === false && r.message).toContain('Chưa cài Lịch');
    expect(rows(m)).toHaveLength(0);
    expect(m.calendar.delivered).toHaveLength(0);
  });

  test('tenant chỉ đọc ⇒ READ_ONLY: không gửi, không ghi', async () => {
    const m = machine();
    const noteId = await createNote(m.sdk);
    m.setNet('ro');
    const r = await sendReminder(m.sdk, { noteId, text: 'x', at: '2026-10-12T07:00' });
    expect(r).toMatchObject({ ok: false, reason: 'READ_ONLY' });
    expect(m.calendar.delivered).toHaveLength(0);
    m.setNet('online');
    expect(rows(m)).toHaveLength(0);
  });

  test('đầu vào sai (nội dung rỗng, giờ sai/ngày không có thật) bị chặn trước khi gửi', async () => {
    const m = machine();
    const noteId = await createNote(m.sdk);
    for (const bad of [{ text: '   ', at: '2026-10-12T07:00' }, { text: 'x', at: '' }, { text: 'x', at: '2026-10-12 07:00' }]) {
      expect(await sendReminder(m.sdk, { noteId, ...bad })).toMatchObject({ ok: false, reason: 'INVALID' });
    }
    expect(m.calendar.delivered).toHaveLength(0);
  });

  test('nội dung dài hơn 200 ký tự bị cắt về 200 (đúng schema Lịch)', async () => {
    const m = machine();
    const noteId = await createNote(m.sdk);
    await sendReminder(m.sdk, { noteId, text: 'a'.repeat(300), at: '2026-10-12T07:00' });
    expect((m.calendar.delivered[0].payload as { title: string }).title).toHaveLength(200);
  });

  test('gửi lại với cùng id ⇒ không nhân đôi dòng nhớ (cập nhật tại chỗ)', async () => {
    const m = machine();
    const noteId = await createNote(m.sdk);
    const id = newId();
    await sendReminder(m.sdk, { noteId, text: 'một', at: '2026-10-12T07:00', id });
    await sendReminder(m.sdk, { noteId, text: 'hai', at: '2026-10-13T08:30', id });
    const list = await listReminders(m.sdk, noteId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, at_local: '2026-10-13T08:30', title: 'hai' });
    expect(m.calendar.delivered.map((d) => (d.payload as { id: string }).id)).toEqual([id, id]);
  });

  test('một note nhiều lời nhắc; liệt kê mới nhất đầu; note khác không lẫn', async () => {
    const m = machine();
    const a = await createNote(m.sdk);
    const b = await createNote(m.sdk);
    const r1 = (await sendReminder(m.sdk, { noteId: a, text: 'một', at: '2026-10-12T07:00' })) as { id: string };
    await new Promise((r) => setTimeout(r, 15));
    const r2 = (await sendReminder(m.sdk, { noteId: a, text: 'hai', at: '2026-10-17T07:00' })) as { id: string };
    await sendReminder(m.sdk, { noteId: b, text: 'ba', at: '2026-10-12T17:00' });
    const list = await listReminders(m.sdk, a);
    expect(list.map((x) => x.id)).toEqual([r2.id, r1.id]);
    expect(await listReminders(m.sdk, b)).toHaveLength(1);
  });

  test('bỏ dòng nhớ = xoá mềm, không gửi gì sang Lịch; gửi lại cùng id không làm sống lại', async () => {
    const m = machine();
    const noteId = await createNote(m.sdk);
    const r = (await sendReminder(m.sdk, { noteId, text: 'x', at: '2026-10-12T07:00' })) as { id: string };
    const sent = m.calendar.delivered.length;
    await forgetReminder(m.sdk, r.id);
    expect(await listReminders(m.sdk, noteId)).toHaveLength(0);
    expect(rows(m)).toHaveLength(1); // còn dòng, đã xoá mềm
    expect(rows(m)[0].deleted_at).toBeTruthy();
    expect(m.calendar.delivered).toHaveLength(sent);
    await saveReminder(m.sdk, { id: r.id, note_id: noteId, at_local: '2026-10-12T07:00', title: 'x' });
    expect(await listReminders(m.sdk, noteId)).toHaveLength(0);
    expect(rows(m)).toHaveLength(1);
  });

  test('purge note quá hạn thùng rác cũng dọn dòng nhớ của note đó', async () => {
    const m = machine();
    const noteId = await createNote(m.sdk, newId(), 'cũ');
    await sendReminder(m.sdk, { noteId, text: 'x', at: '2026-10-12T07:00' });
    m.db.run(`UPDATE ${PREFIX}_notes SET created_at = ? WHERE id = ?`, [new Date(Date.now() - 60 * DAY_MS).toISOString(), noteId]);
    await trashNote(m.sdk, noteId, Date.now() - (TRASH_DAYS + 1) * DAY_MS);
    expect(await purgeExpired(m.sdk)).toBe(1);
    expect(rows(m, true).every((r) => r.deleted_at)).toBe(true);
    expect(await listReminders(m.sdk, noteId)).toHaveLength(0);
  });
});

describe('mở trong Lịch (calendar.event.open)', () => {
  test('gửi {eventId} mode open, đúng schema', async () => {
    const m = machine();
    const id = newId();
    expect(await openInCalendar(m.sdk, id)).toBe('');
    expect(m.calendar.delivered[0]).toMatchObject({ type: 'calendar.event.open', mode: 'open', payload: { eventId: id } });
    expect(ajv.compile(calSchema('calendar.event.open'))(m.calendar.delivered[0].payload)).toBe(true);
  });

  test('Lịch chưa cài ⇒ trả thông điệp banner; chỉ đọc vẫn mở được (mode open không ghi)', async () => {
    const m = machine();
    m.calendar.installed = false;
    expect(await openInCalendar(m.sdk, newId())).toBe(NO_CALENDAR);
    m.calendar.installed = true;
    m.setNet('ro');
    expect(await openInCalendar(m.sdk, newId())).toBe('');
  });

  test('app không khai sends thì bridge từ chối (SCOPE_DENIED) — manifest là cổng thật', async () => {
    const m = machine();
    const orig = manifest.intents!.sends;
    try {
      manifest.intents!.sends = [];
      await expect(m.sdk.intent.send('calendar.event.open', { eventId: newId() }, { mode: 'open' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    } finally {
      manifest.intents!.sends = orig;
    }
  });
});

describe('điều kiện bấm "Nhắc tôi"', () => {
  test('tắt khi chỉ đọc hoặc note ở thùng rác', () => {
    expect(canRemind({ readOnly: false, trashed: false })).toBe(true);
    expect(canRemind({ readOnly: true, trashed: false })).toBe(false);
    expect(canRemind({ readOnly: false, trashed: true })).toBe(false);
  });
  test('nội dung mặc định = tiêu đề note, rỗng thì "Ghi chú"', () => {
    expect(defaultText('  Đi chợ ')).toBe('Đi chợ');
    expect(defaultText('')).toBe('Ghi chú');
    expect(defaultText('x'.repeat(250))).toHaveLength(200);
  });
});

describe('nút nhanh, định dạng, giờ đã qua', () => {
  // thứ Sáu 09/10/2026 10:30 (giờ máy)
  const fri = new Date(2026, 9, 9, 10, 30, 45);
  const at = (o: { key: string; at: string }[], k: string) => o.find((x) => x.key === k)?.at;

  test('thứ Sáu 10:30: sau 1 giờ · chiều nay 17:00 · sáng mai 07:00 (thứ Bảy) · cuối tuần = thứ Bảy 07:00', () => {
    const q = quickOptions(fri);
    expect(q.map((x) => x.label)).toEqual(['Sau 1 giờ', 'Chiều nay', 'Sáng mai', 'Cuối tuần']);
    expect(at(q, 'h1')).toBe('2026-10-09T11:30');
    expect(at(q, 'pm')).toBe('2026-10-09T17:00');
    expect(at(q, 'am')).toBe('2026-10-10T07:00');
    expect(at(q, 'we')).toBe('2026-10-10T07:00');
  });

  test('chiều nay: qua 17:00 thì 19:00; qua 19:00 thì ẩn', () => {
    expect(at(quickOptions(new Date(2026, 9, 9, 17, 0)), 'pm')).toBe('2026-10-09T19:00');
    expect(at(quickOptions(new Date(2026, 9, 9, 19, 0)), 'pm')).toBeUndefined();
    expect(quickOptions(new Date(2026, 9, 9, 23, 30)).map((x) => x.key)).toEqual(['h1', 'am', 'we']);
    expect(at(quickOptions(new Date(2026, 9, 9, 23, 30)), 'h1')).toBe('2026-10-10T00:30'); // qua nửa đêm
  });

  test('cuối tuần: thứ Hai → thứ Bảy 07:00; thứ Bảy sớm → hôm nay; thứ Bảy muộn / Chủ Nhật → thứ Bảy tuần sau/này', () => {
    expect(at(quickOptions(new Date(2026, 9, 5, 9, 0)), 'we')).toBe('2026-10-10T07:00'); // thứ Hai
    expect(at(quickOptions(new Date(2026, 9, 10, 6, 0)), 'we')).toBe('2026-10-10T07:00'); // thứ Bảy 06:00
    expect(at(quickOptions(new Date(2026, 9, 10, 8, 0)), 'we')).toBe('2026-10-17T07:00'); // thứ Bảy 08:00
    expect(at(quickOptions(new Date(2026, 9, 11, 8, 0)), 'we')).toBe('2026-10-17T07:00'); // Chủ Nhật
  });

  test('qua ranh tháng/năm', () => {
    expect(at(quickOptions(new Date(2026, 11, 31, 20, 0)), 'am')).toBe('2027-01-01T07:00');
    expect(at(quickOptions(new Date(2026, 11, 31, 20, 0)), 'h1')).toBe('2026-12-31T21:00');
  });

  test('định dạng "Thứ Hai 12/10 07:00" và dòng tóm tắt', () => {
    expect(formatShort('2026-10-12T07:00')).toBe('Thứ Hai 12/10 07:00');
    expect(formatShort('2026-10-11T19:05')).toBe('Chủ Nhật 11/10 19:05');
    expect(formatShort('rác')).toBe('rác');
    expect(formatSummary('2026-10-12', '07:00')).toBe('Thứ Hai, 12/10/2026 · 07:00');
    expect(formatSummary('', '')).toBe('Chưa chọn ngày');
    expect(formatSummary('2026-02-31', '07:00')).toBe('Ngày chưa hợp lệ');
  });

  test('parseAt/toAt khứ hồi; từ chối ngày không có thật', () => {
    expect(toAt(parseAt('2026-10-12T07:00')!)).toBe('2026-10-12T07:00');
    expect(parseAt('2026-02-30T07:00')).toBeNull();
    expect(parseAt('2026-10-12T25:00')).toBeNull();
    expect(parseAt('2026-10-12')).toBeNull();
  });

  test('cảnh báo giờ đã qua so đến phút', () => {
    expect(isPast('2026-10-09T10:29', fri)).toBe(true);
    expect(isPast('2026-10-09T10:30', fri)).toBe(false); // cùng phút = chưa qua
    expect(isPast('2026-10-09T10:31', fri)).toBe(false);
    expect(isPast('', fri)).toBe(false);
  });

  test('giờ đã qua vẫn gửi được (Lịch nhắc ngay)', async () => {
    const m = machine();
    const noteId = await createNote(m.sdk);
    expect(await sendReminder(m.sdk, { noteId, text: 'x', at: '2020-01-01T07:00' })).toMatchObject({ ok: true });
  });
});
