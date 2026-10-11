// Sinh SQL dữ liệu mẫu cho dogfood đợt 2: ~30 ghi chú tiếng Việt có dấu, checklist, tag, đính kèm giả,
// 1 note có 250 dòng note_blocks (kiểm gộp), 2 note thùng rác (còn 3 ngày + quá hạn để kiểm job server).
// Dùng:  node scripts/seed-notes.mjs <tenant_id> [số_note] > notes.sql   (rồi psql < notes.sql). Chạy lại an toàn (ON CONFLICT DO NOTHING).
// id tất định theo (tenant, số thứ tự) nên chạy lại không nhân đôi. Nội dung Yjs dựng đúng schema của trình soạn (TipTap).
import { createHash } from 'node:crypto';
import * as Y from 'yjs';

const tenant = process.argv[2];
if (!tenant || !/^[0-9a-f-]{36}$/.test(tenant)) {
  console.error('Dùng: node scripts/seed-notes.mjs <tenant_id uuid> [số_note]');
  process.exit(1);
}
const COUNT = Number(process.argv[3] ?? 30);
const DAY = 86_400_000;
const now = Date.now();

const uuidFor = (name) => {
  const h = createHash('sha1').update(`${tenant}:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const iso = (ms) => new Date(ms).toISOString();
const b64 = (u8) => Buffer.from(u8).toString('base64');

const normalize = (s) =>
  s.replace(/[đĐ]/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const snippet = (t, max = 160) => {
  const x = t.replace(/\s+/g, ' ').trim();
  return x.length > max ? `${x.slice(0, max - 1)}…` : x;
};

// ---- dựng tài liệu Yjs đúng tên node của TipTap ----
function build(spec) {
  const doc = new Y.Doc();
  const lines = [];
  doc.transact(() => {
    const frag = doc.getXmlFragment('default');
    const text = (parent, s) => {
      const t = new Y.XmlText();
      parent.push([t]);
      t.insert(0, s);
    };
    const para = (parent, s) => {
      const p = new Y.XmlElement('paragraph');
      parent.push([p]);
      if (s) text(p, s);
    };
    for (const b of spec) {
      if (b.p !== undefined) {
        para(frag, b.p);
        lines.push(b.p);
      }
      else if (b.h) {
        const h = new Y.XmlElement('heading');
        frag.push([h]);
        h.setAttribute('level', 2);
        text(h, b.h);
        lines.push(b.h);
      } else if (b.ul || b.ol) {
        const list = new Y.XmlElement(b.ul ? 'bulletList' : 'orderedList');
        frag.push([list]);
        for (const s of b.ul ?? b.ol) {
          const li = new Y.XmlElement('listItem');
          list.push([li]);
          para(li, s);
          lines.push(s);
        }
      } else if (b.tasks) {
        const list = new Y.XmlElement('taskList');
        frag.push([list]);
        for (const [s, done] of b.tasks) {
          const li = new Y.XmlElement('taskItem');
          list.push([li]);
          li.setAttribute('checked', !!done);
          para(li, s);
          lines.push(s);
        }
      }
    }
  });
  return { doc, text: lines.join('\n') };
}

const TAG = { nha: '00000000-0000-4000-8000-0000000000c1', viec: '00000000-0000-4000-8000-0000000000c2', gd: '00000000-0000-4000-8000-0000000000c3' };

const TOPICS = [
  ['Danh sách đi chợ', [{ p: 'Chủ nhật này nhớ mua:' }, { tasks: [['Rau muống, cà chua', false], ['Sữa tươi không đường', true], ['Gạo ST25 5 kg', false]] }], [TAG.nha], true],
  ['Họp tuần — đăng ký phòng', [{ h: 'Việc cần chốt' }, { ul: ['Đăng ký phòng họp thứ Ba', 'Gửi tài liệu trước 17:00'] }], [TAG.viec], false],
  ['Ý tưởng app đọc báo', [{ p: 'Lưu bài thành ghi chú rồi đặt nhắc đọc lại. Cần chữ to cho bố mẹ.' }], [], false],
  ['Ghi chú nhanh', [{ p: 'Mật khẩu wifi nhà bà ngoại ghi ở mặt sau tủ lạnh.' }], [TAG.gd], false],
  ['Sửa vòi nước nhà bếp', [{ p: 'Gọi thợ Tuấn, hẹn chiều thứ Sáu. Mang theo ống dự phòng.' }], [TAG.nha], false],
  ['Đăng ký khoá học tiếng Anh', [{ p: 'Hạn đăng ký ngày 15. Học phí trả theo quý.' }], [TAG.viec], false],
  ['Quà sinh nhật mẹ', [{ p: 'Khăn lụa màu xanh, hoặc ghế massage nhỏ.' }], [TAG.gd], false],
  ['Câu hỏi cho bác sĩ', [{ ol: ['Thuốc huyết áp uống lúc nào', 'Lịch tái khám tháng sau', 'Có cần xét nghiệm máu không'] }], [TAG.gd], false],
  ['Kế hoạch đi Đà Lạt', [{ h: 'Chuẩn bị' }, { tasks: [['Đặt phòng', true], ['Thuê xe', false], ['Mang áo ấm', false]] }, { p: 'Đi ba ngày hai đêm, xuất phát sáng thứ Bảy.' }], [TAG.gd], false],
  ['Công thức bún riêu', [{ p: 'Cua đồng xay, cà chua, mẻ, đậu phụ chiên. Nêm nước mắm ngon.' }], [TAG.nha], false],
  ['Họp khách hàng ABC', [{ p: 'Trình bày bản demo, chốt phạm vi vòng một. Người tham dự: anh Nam, chị Lan.' }], [TAG.viec], false],
  ['Số điện thoại thợ điện', [{ p: 'Anh Hùng — 0912 345 678. Làm việc cuối tuần.' }], [TAG.nha], false],
  ['Sách muốn đọc', [{ ul: ['Đắc nhân tâm', 'Nhà giả kim', 'Dế Mèn phiêu lưu ký'] }], [], false],
  ['Việc cần làm tuần này', [{ tasks: [['Nộp báo cáo quý', false], ['Đóng tiền điện nước', true], ['Đặt lịch khám răng', false], ['Gọi bảo hiểm xe', false]] }], [TAG.viec], true],
  ['Lịch học của con', [{ p: 'Thứ Hai: Toán, Văn. Thứ Tư: Tiếng Anh. Thứ Sáu: Mỹ thuật.' }], [TAG.gd], false],
];

const rows = { notes: [], blocks: [], tags: [], files: [] };
let n = 0;
const add = (key, title, spec, tags, pinned, opts = {}) => {
  const id = uuidFor(`note:${key}`);
  const { doc, text } = build(spec);
  const ageMs = (opts.ageDays ?? n * 0.7) * DAY;
  const created = now - ageMs;
  const updated = opts.updatedMs ?? created;
  rows.notes.push({ id, title, pinned: pinned ? 1 : 0, trashed: opts.trashedMs ?? null, search: normalize(`${title} ${text}`), snip: snippet(text), created, updated });
  rows.blocks.push({ id: uuidFor(`block:${key}:0`), note: id, kind: 'update', data: b64(Y.encodeStateAsUpdate(doc)), created });
  for (const t of tags) rows.tags.push({ id: uuidFor(`tag:${key}:${t}`), note: id, tag: t, created });
  n++;
  return { id, doc };
};

for (let i = 0; i < COUNT; i++) {
  const [title, spec, tags, pinned] = TOPICS[i % TOPICS.length];
  const suffix = i >= TOPICS.length ? ` (${Math.floor(i / TOPICS.length) + 1})` : '';
  add(`t${i}`, title + suffix, spec, i < TOPICS.length ? tags : [], i < TOPICS.length ? pinned : false);
}

// note có đính kèm giả (liên kết tới core_files do dogfood tự chọn — ở đây chỉ dòng liên kết trỏ file không tồn tại → "đang tải về…")
const withAtt = add('att', 'Ghi chú có đính kèm', [{ p: 'Ảnh phác thảo và tệp PDF lịch họp.' }], [TAG.viec], false);
rows.files.push({ id: uuidFor('file:att:1'), note: withAtt.id, file: uuidFor('corefile:1'), kind: 'pdf', name: 'lich-hop-tuan.pdf', mime: 'application/pdf', size: 220 * 1024, created: now });

// note 250 dòng update (kiểm gộp > 200)
{
  const id = uuidFor('note:big');
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  const lines = [];
  let created = now - 3 * DAY;
  for (let i = 0; i < 250; i++) {
    const before = Y.encodeStateVector(doc);
    const line = `Dòng nhật ký số ${i + 1}: hôm nay đăng ký và ghi chú thêm một ý`;
    doc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      frag.push([p]);
      const t = new Y.XmlText();
      p.push([t]);
      t.insert(0, line);
    });
    lines.push(line);
    rows.blocks.push({ id: uuidFor(`block:big:${i}`), note: id, kind: 'update', data: b64(Y.encodeStateAsUpdate(doc, before)), created: (created += 1000) });
  }
  const text = lines.join('\n');
  rows.notes.push({ id, title: 'Nhật ký dài (250 bản cập nhật)', pinned: 0, trashed: null, search: normalize(`Nhật ký dài (250 bản cập nhật) ${text}`), snip: snippet(text), created: now - 3 * DAY, updated: now - DAY });
}

// thùng rác: còn 3 ngày (đã xoá 27 ngày) và quá hạn (đã xoá 40 ngày) — updated_at giờ server cũng lùi để job dọn nhận ra
add('trash3', 'Danh sách cũ — đi Đà Lạt', [{ p: 'Áo ấm, ô, thuốc say xe.' }], [TAG.nha], false, { ageDays: 60, trashedMs: now - 27 * DAY, updatedMs: now - 27 * DAY });
add('trash40', 'Nháp thư xin nghỉ (quá hạn)', [{ p: 'Kính gửi anh chị, em xin nghỉ phép ngày 20.' }], [], false, { ageDays: 70, trashedMs: now - 40 * DAY, updatedMs: now - 40 * DAY });

// ---- SQL ----
const out = ['begin;', 'alter table app_vn_app_note_notes disable trigger user;', 'alter table app_vn_app_note_note_blocks disable trigger user;', 'alter table app_vn_app_note_note_tags disable trigger user;', 'alter table app_vn_app_note_note_files disable trigger user;'];
for (const r of rows.notes) {
  out.push(`insert into app_vn_app_note_notes (id, tenant_id, title, pinned, trashed_at_ms, search_text, snippet, created_at, updated_at) values (${q(r.id)}, ${q(tenant)}, ${q(r.title)}, ${r.pinned}, ${r.trashed ?? 'null'}, ${q(r.search)}, ${q(r.snip)}, ${q(iso(r.created))}, ${q(iso(r.updated))}) on conflict (id) do nothing;`);
}
for (const b of rows.blocks) {
  out.push(`insert into app_vn_app_note_note_blocks (id, tenant_id, note_id, kind, data, size, created_at, updated_at) values (${q(b.id)}, ${q(tenant)}, ${q(b.note)}, ${q(b.kind)}, ${q(b.data)}, ${b.data.length}, ${q(iso(b.created))}, ${q(iso(b.created))}) on conflict (id) do nothing;`);
}
for (const t of rows.tags) {
  out.push(`insert into app_vn_app_note_note_tags (id, tenant_id, note_id, tag_id, created_at, updated_at) select ${q(t.id)}, ${q(tenant)}, ${q(t.note)}, ${q(t.tag)}, ${q(iso(t.created))}, ${q(iso(t.created))} where exists (select 1 from core_tags where id = ${q(t.tag)}) on conflict (id) do nothing;`);
}
for (const f of rows.files) {
  out.push(`insert into app_vn_app_note_note_files (id, tenant_id, note_id, file_id, kind, name, mime, size, created_at, updated_at) values (${q(f.id)}, ${q(tenant)}, ${q(f.note)}, ${q(f.file)}, ${q(f.kind)}, ${q(f.name)}, ${q(f.mime)}, ${f.size}, ${q(iso(f.created))}, ${q(iso(f.created))}) on conflict (id) do nothing;`);
}
out.push('alter table app_vn_app_note_notes enable trigger user;', 'alter table app_vn_app_note_note_blocks enable trigger user;', 'alter table app_vn_app_note_note_tags enable trigger user;', 'alter table app_vn_app_note_note_files enable trigger user;', 'commit;');
process.stdout.write(out.join('\n') + '\n');
console.error(`đã sinh ${rows.notes.length} note, ${rows.blocks.length} dòng note_blocks, ${rows.tags.length} liên kết tag cho tenant ${tenant}`);
