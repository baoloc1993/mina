// Sinh SQL dữ liệu mẫu Lịch cho dogfood đợt 2 (PRD §7 "Dữ liệu mẫu"): ~12 mục tiếng Việt có dấu — giỗ/rằm lặp âm lịch, lời nhắc hằng ngày,
// họp tuần giờ cố định, sự kiện có báo trước, lời nhắc từ Ghi chú, mục đã xoá mềm, ngoại lệ "chỉ lần này" (edit + skip), chuỗi lặp ngày 400 ngày.
// Dùng:  node scripts/seed-calendar.mjs <tenant_id> > calendar.sql   (rồi psql < calendar.sql). Chạy lại an toàn (ON CONFLICT DO NOTHING).
// id tất định theo (tenant, tên) — chạy lại không nhân đôi; ngày tuyệt đối tính từ HÔM NAY (giờ máy chạy script). KHÔNG tính âm lịch ở đây:
// chỉ neo lunar_month / lunar_day, app tự suy ra ngày dương. Giờ treo lưu `YYYY-MM-DDTHH:mm`, cả ngày `YYYY-MM-DD`.
import { createHash } from 'node:crypto';

const tenant = process.argv[2];
if (!tenant || !/^[0-9a-f-]{36}$/.test(tenant)) {
  console.error('Dùng: node scripts/seed-calendar.mjs <tenant_id uuid>');
  process.exit(1);
}
const DAY = 86_400_000;
const now = Date.now();
const TZ = 'Asia/Ho_Chi_Minh'; // UTC+7, không có giờ mùa hè
const TZ_OFFSET_MS = 7 * 3_600_000;

const uuidFor = (name) => {
  const h = createHash('sha1').update(`${tenant}:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const q = (s) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const num = (n) => (n === null || n === undefined ? 'null' : String(n));
const iso = (ms) => new Date(ms).toISOString();

// Ngày dương theo lịch địa phương của máy chạy (hôm nay = 00:00 địa phương).
const today = new Date();
today.setHours(0, 0, 0, 0);
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const local = (d, hh, mm) => `${ymd(d)}T${p2(hh)}:${p2(mm)}`;
const nextWeekday = (wd, from = today) => { // wd: 0 = Chủ nhật … 1 = Thứ Hai … 3 = Thứ Tư; lần SAU hôm nay
  const d = addDays(from, 1);
  while (d.getDay() !== wd) d.setDate(d.getDate() + 1);
  return d;
};
// Giờ cố định: epoch ms của (ngày, giờ) tại Asia/Ho_Chi_Minh.
const fixedMs = (d, hh, mm) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm) - TZ_OFFSET_MS;

const events = [];
const overrides = [];
const ev = (key, o) => {
  const e = {
    id: uuidFor(`event:${key}`), kind: 'event', title: '', all_day: 0, start_local: '', end_local: null, fixed: 0, start_ms: null, end_ms: null, tz: null,
    repeat_unit: null, repeat_every: 1, repeat_cal: 'solar', repeat_until: null, lunar_month: null, lunar_day: null, alert_min: 0, done_at_ms: null,
    src_app: null, src_id: null, deleted_at_ms: null, ageDays: 20, ...o,
  };
  events.push(e);
  return e;
};

// 1. Giỗ: lặp năm theo âm lịch 12/3, cả ngày (ngày dương neo = một ngày giả định trong tương lai; app tự tính lại theo lunar_month/lunar_day).
ev('gio', { title: 'Giỗ ông nội', all_day: 1, start_local: ymd(addDays(today, 30)), repeat_unit: 'year', repeat_cal: 'lunar', lunar_month: 3, lunar_day: 12, alert_min: 1440 });
// 2. Rằm: lặp tháng theo âm lịch ngày 15, cả ngày.
ev('ram', { title: 'Rằm', all_day: 1, start_local: ymd(addDays(today, 7)), repeat_unit: 'month', repeat_cal: 'lunar', lunar_day: 15, alert_min: 1440 });
// 3. Lời nhắc hằng ngày 07:00 (giờ treo).
ev('thuoc', { kind: 'reminder', title: 'Uống thuốc', start_local: local(today, 7, 0), repeat_unit: 'day', alert_min: 0, ageDays: 40 });
// 4. Họp tuần: thứ Hai 09:00–10:00, giờ cố định theo múi giờ.
const mon = nextWeekday(1);
ev('hop', { title: 'Họp tuần', start_local: local(mon, 9, 0), end_local: local(mon, 10, 0), fixed: 1, start_ms: fixedMs(mon, 9, 0), end_ms: fixedMs(mon, 10, 0), tz: TZ, repeat_unit: 'week', alert_min: 10 });
// 5. Khám răng: 14:00–15:00 ngày 14/10/2026, báo trước 60 phút.
ev('rang', { title: 'Khám răng', start_local: '2026-10-14T14:00', end_local: '2026-10-14T15:00', alert_min: 60 });
// 6. Lời nhắc tạo từ Ghi chú "Danh sách đi chợ" (cùng công thức uuid với seed-notes: uuidFor('note:t0')).
ev('cho', { kind: 'reminder', title: 'Danh sách đi chợ', start_local: local(addDays(today, 1), 17, 0), alert_min: 10, src_app: 'vn.app.note', src_id: uuidFor('note:t0') });
// 7. Mục đã xoá mềm.
ev('xoa', { title: 'Hẹn cũ đã xoá', start_local: local(addDays(today, 2), 10, 0), end_local: local(addDays(today, 2), 11, 0), deleted_at_ms: now - DAY, ageDays: 10 });
// 8. Lặp tuần có ngoại lệ "chỉ lần này": sửa giờ của lần thứ hai, bỏ qua lần thứ ba.
const wed = nextWeekday(3);
const english = ev('anh', { title: 'Học tiếng Anh', start_local: local(wed, 19, 0), end_local: local(wed, 20, 30), repeat_unit: 'week', alert_min: 10 });
overrides.push({ id: uuidFor('override:anh:edit'), event: english.id, occ: ymd(addDays(wed, 7)), action: 'edit', patch: JSON.stringify({ start_local: local(addDays(wed, 7), 20, 0), end_local: local(addDays(wed, 7), 21, 30) }) });
overrides.push({ id: uuidFor('override:anh:skip'), event: english.id, occ: ymd(addDays(wed, 14)), action: 'skip', patch: '{}' });
// 9. Chuỗi lặp ngày không dừng sớm — kiểm trần 40/50 lần hiển thị: kết thúc sau 400 ngày.
ev('chuoi', { title: 'Chuỗi thử 400 ngày', start_local: local(today, 8, 0), end_local: local(today, 8, 30), repeat_unit: 'day', repeat_until: ymd(addDays(today, 400)), alert_min: 0 });
// 10. Sinh nhật mẹ: lặp năm dương, cả ngày.
ev('sn', { title: 'Sinh nhật mẹ', all_day: 1, start_local: ymd(addDays(today, 45)), repeat_unit: 'year', alert_min: 1440 });
// 11. Đóng tiền điện: lặp tháng dương, cả ngày.
ev('dien', { title: 'Đóng tiền điện', all_day: 1, start_local: ymd(addDays(today, 5)), repeat_unit: 'month', alert_min: 1440 });
// 12. Lời nhắc một lần đã xong.
ev('bc', { kind: 'reminder', title: 'Nộp báo cáo quý', start_local: local(addDays(today, -1), 16, 0), alert_min: 60, done_at_ms: now - DAY / 2 });

const T = ['app_vn_app_calendar_events', 'app_vn_app_calendar_event_overrides'];
const out = ['begin;', ...T.map((t) => `alter table ${t} disable trigger user;`)];
for (const e of events) {
  const created = now - e.ageDays * DAY;
  out.push(
    `insert into app_vn_app_calendar_events (id, tenant_id, kind, title, all_day, start_local, end_local, fixed, start_ms, end_ms, tz, repeat_unit, repeat_every, repeat_cal, repeat_until, lunar_month, lunar_day, alert_min, done_at_ms, src_app, src_id, created_at, updated_at, deleted_at) values (` +
      [q(e.id), q(tenant), q(e.kind), q(e.title), e.all_day, q(e.start_local), q(e.end_local), e.fixed, num(e.start_ms), num(e.end_ms), q(e.tz), q(e.repeat_unit), e.repeat_every, q(e.repeat_cal), q(e.repeat_until), num(e.lunar_month), num(e.lunar_day), e.alert_min, num(e.done_at_ms), q(e.src_app), q(e.src_id), q(iso(created)), q(iso(created)), e.deleted_at_ms ? q(iso(e.deleted_at_ms)) : 'null'].join(', ') +
      `) on conflict (id) do nothing;`,
  );
}
for (const o of overrides) {
  out.push(
    `insert into app_vn_app_calendar_event_overrides (id, tenant_id, event_id, occ_date, action, patch, created_at, updated_at) values (${[q(o.id), q(tenant), q(o.event), q(o.occ), q(o.action), q(o.patch), q(iso(now)), q(iso(now))].join(', ')}) on conflict (id) do nothing;`,
  );
}
out.push(...T.map((t) => `alter table ${t} enable trigger user;`), 'commit;');
process.stdout.write(out.join('\n') + '\n');
console.error(`đã sinh ${events.length} mục Lịch, ${overrides.length} ngoại lệ cho tenant ${tenant}`);
