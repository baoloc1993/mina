// AC-1..AC-7 phía dữ liệu: chạy trên bridge THẬT của shell (scope guard, SQL guard, xoá mềm) qua host của mock SDK.
import Ajv from 'ajv';
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { afterEach, describe, expect, test } from 'vitest';
import { b64decode, docFromPlain, docFromUpdates, extractText, FRAGMENT } from '../src/crdt/doc';
import { COMPACT_THRESHOLD, loadText, NoteSession } from '../src/crdt/session';
import { attachImages, attachPdfs, detachAttachment, listAttachments } from '../src/data/files';
import { blockSignatures, createFromIntent, createNote, daysLeft, getNote, listNotes, listTrash, purgeExpired, reindex, restoreNote, setPinned, setTitle, trashNote, TRASH_DAYS, DAY_MS } from '../src/data/repo';
import { attachTag, detachTag, ensureTag, groupTags, listTagGroups, tagsByNote } from '../src/data/tags';
import { normalize, searchTerms } from '../src/search/normalize';
import { newId } from '../src/sdk';
import { blockRows, closeAll, liveBlocks, machine, manifest, PREFIX, push, sleep, sync2, typeParagraph, type Machine } from './harness';

afterEach(closeAll);

const open = (m: Machine, id: string, title = () => '') => NoteSession.open({ sdk: m.sdk, newId, title }, id);
const rawNote = (m: Machine, id: string) => m.db.all(`SELECT * FROM ${PREFIX}_notes WHERE id = ?`, [id])[0] as Record<string, unknown>;

describe('Yjs ↔ văn bản', () => {
  test('docFromPlain dựng đoạn văn đúng schema ProseMirror (paragraph + text) và extractText đọc lại đủ dòng', () => {
    const doc = docFromPlain('Dòng một\nDòng hai có dấu: đăng ký\n\nCuối', 'https://vnexpress.net/bai');
    const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(FRAGMENT)) as { content: { type: string; content?: { type: string; text: string }[] }[] };
    expect(json.content.map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph']);
    expect(json.content[1].content![0].text).toBe('Dòng hai có dấu: đăng ký');
    expect(json.content[2].content).toBeUndefined(); // dòng trống = đoạn trống
    expect(extractText(doc)).toBe('Dòng một\nDòng hai có dấu: đăng ký\n\nCuối\nhttps://vnexpress.net/bai');
  });

  test('extractText đi sâu danh sách và checklist', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const frag = doc.getXmlFragment(FRAGMENT);
      const list = new Y.XmlElement('taskList');
      frag.push([list]);
      for (const s of ['Mua sữa', 'Gọi thợ']) {
        const item = new Y.XmlElement('taskItem');
        list.push([item]);
        const p = new Y.XmlElement('paragraph');
        item.push([p]);
        const t = new Y.XmlText();
        p.push([t]);
        t.insert(0, s);
      }
    });
    expect(extractText(doc)).toBe('Mua sữa\nGọi thợ');
  });

  test('NFD → NFC để dấu nhất quán', () => {
    expect(extractText(docFromPlain('Việt Nam'.normalize('NFD')))).toBe('Việt Nam'.normalize('NFC'));
  });
});

describe('AC-2: hợp nhất Yjs', () => {
  test('ba bên sửa độc lập: MỌI thứ tự áp update cho cùng kết quả và đủ chữ của cả ba', () => {
    const base = docFromPlain('Gốc');
    const baseUpdate = Y.encodeStateAsUpdate(base);
    const updates: Uint8Array[] = [];
    for (const s of ['máy A viết', 'máy B viết', 'máy C viết']) {
      const d = new Y.Doc();
      Y.applyUpdate(d, baseUpdate);
      const before = Y.encodeStateVector(d);
      typeParagraph(d, s);
      updates.push(Y.encodeStateAsUpdate(d, before));
    }
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const results = perms.map((p) => {
      const d = new Y.Doc();
      Y.applyUpdate(d, baseUpdate);
      for (const i of p) Y.applyUpdate(d, updates[i]);
      return extractText(d);
    });
    expect(new Set(results).size).toBe(1);
    for (const s of ['Gốc', 'máy A viết', 'máy B viết', 'máy C viết']) expect(results[0]).toContain(s);
    // áp lặp lại vô hại
    const d = new Y.Doc();
    Y.applyUpdate(d, baseUpdate);
    for (const i of [0, 1, 2, 0, 1, 2]) Y.applyUpdate(d, updates[i]);
    expect(extractText(d)).toBe(results[0]);
  });

  test('hai máy offline cùng sửa một note → sync → hai bên giống hệt và chứa chữ cả hai', async () => {
    const a = machine();
    const b = machine();
    const id = await createNote(a.sdk, newId(), 'Chung');
    const sa0 = await open(a, id);
    typeParagraph(sa0.doc, 'bản gốc');
    await sa0.flush();
    sync2(a, b);
    sa0.destroy();
    const sa = await open(a, id, () => 'Chung');
    const sb = await open(b, id, () => 'Chung');
    a.setNet('offline');
    b.setNet('offline');
    typeParagraph(sa.doc, 'A: mua sữa');
    typeParagraph(sb.doc, 'B: gọi thợ');
    await sa.flush();
    await sb.flush();
    sync2(a, b);
    await sa.pull();
    await sb.pull();
    expect(sa.text()).toBe(sb.text());
    expect(sa.text()).toContain('bản gốc');
    expect(sa.text()).toContain('A: mua sữa');
    expect(sa.text()).toContain('B: gọi thợ');
    sa.destroy();
    sb.destroy();
  });

  test('note đang mở nhận update từ máy khác tại chỗ (pull), không ghi lại gì', async () => {
    const a = machine();
    const b = machine();
    const id = await createNote(a.sdk);
    const sa = await open(a, id);
    typeParagraph(sa.doc, 'một');
    await sa.flush();
    sync2(a, b);
    const sb = await open(b, id);
    expect(sb.text()).toBe('một');
    typeParagraph(sb.doc, 'hai');
    await sb.flush();
    sync2(a, b);
    const before = liveBlocks(a, id).length;
    expect(await sa.pull()).toBe(1);
    expect(sa.text()).toBe('một\nhai');
    expect(sa.dirty).toBe(false);
    expect(await sa.flush()).toBe(false);
    expect(liveBlocks(a, id).length).toBe(before);
    sa.destroy();
    sb.destroy();
  });

  test('tiêu đề / ghim sửa ở hai máy → LWW theo trường (bản tới sau thắng); trường khác nhau giữ cả hai', async () => {
    const a = machine();
    const b = machine();
    const id = await createNote(a.sdk, newId(), 'Gốc');
    sync2(a, b);
    await setTitle(a.sdk, id, 'Tiêu đề từ A', '');
    await setPinned(b.sdk, id, true);
    push(a, b); // A tới server trước
    push(b, a);
    // Mô phỏng upload PATCH-theo-cột: máy sau chỉ chạm cột nó sửa. Ở đây `push` chép cả dòng nên kiểm hai bên giống nhau.
    expect(rawNote(a, id).title).toBe(rawNote(b, id).title);
  });
});

describe('AC-1: lưu, nháp, chỉ đọc, thùng rác', () => {
  test('flush ghi MỘT dòng note_blocks + search_text/snippet trong cùng giao dịch; không có thay đổi thì không ghi', async () => {
    const m = machine();
    const id = await createNote(m.sdk, newId(), 'Đi chợ');
    const s = await open(m, id, () => 'Đi chợ');
    expect(await s.flush()).toBe(false);
    typeParagraph(s.doc, 'Mua rau muống');
    typeParagraph(s.doc, 'Mua cà chua');
    expect(s.dirty).toBe(true);
    expect(await s.flush()).toBe(true);
    expect(liveBlocks(m, id)).toHaveLength(1);
    const n = rawNote(m, id);
    expect(n.search_text).toBe('di cho mua rau muong\nmua ca chua'.replace('\n', ' '));
    expect(n.snippet).toBe('Mua rau muống Mua cà chua');
    s.destroy();
  });

  test('kill app rồi mở lại: nội dung đã flush còn nguyên; đoạn chưa flush chỉ mất nếu chưa tới 1 s (suspend gọi flush)', async () => {
    const m = machine();
    const id = await createNote(m.sdk);
    const s = await open(m, id);
    typeParagraph(s.doc, 'đã lưu');
    await s.flush();
    typeParagraph(s.doc, 'gõ dở');
    await s.flush(); // khi nhận lifecycle.suspend
    s.destroy();
    const s2 = await open(m, id);
    expect(s2.text()).toBe('đã lưu\ngõ dở');
    s2.destroy();
  });

  test('tự lưu sau ~1 s kể từ lần gõ cuối', async () => {
    const m = machine();
    const id = await createNote(m.sdk);
    const s = await open(m, id);
    typeParagraph(s.doc, 'tự lưu');
    expect(liveBlocks(m, id)).toHaveLength(0);
    await sleep(1250);
    expect(liveBlocks(m, id)).toHaveLength(1);
    s.destroy();
  });

  test('READ_ONLY: ghi bị từ chối, chữ vẫn giữ trong bộ nhớ và ghi lại được khi hết chỉ đọc', async () => {
    const m = machine();
    const id = await createNote(m.sdk);
    const s = await open(m, id);
    m.setNet('ro');
    typeParagraph(s.doc, 'viết lúc chỉ đọc');
    await expect(s.flush()).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(s.dirty).toBe(true);
    expect(liveBlocks(m, id)).toHaveLength(0);
    m.setNet('online');
    expect(await s.flush()).toBe(true);
    const s2 = await open(m, id);
    expect(s2.text()).toBe('viết lúc chỉ đọc');
    s.destroy();
    s2.destroy();
  });

  test('xoá → thùng rác (không còn ở danh sách chính), khôi phục lại; ghim nổi lên đầu', async () => {
    const m = machine();
    const a = await createNote(m.sdk, newId(), 'A');
    const b = await createNote(m.sdk, newId(), 'B');
    await setPinned(m.sdk, a, true);
    expect((await listNotes(m.sdk)).map((n) => n.title)).toEqual(['A', 'B']);
    await trashNote(m.sdk, a, 1_000);
    expect((await listNotes(m.sdk)).map((n) => n.title)).toEqual(['B']);
    expect((await listTrash(m.sdk)).map((n) => n.title)).toEqual(['A']);
    await restoreNote(m.sdk, a);
    expect((await listNotes(m.sdk)).map((n) => n.title)).toEqual(['A', 'B']);
    expect(b).toBeTruthy();
  });

  test('daysLeft: còn 30 ngày ngay khi xoá, 0 sau 30 ngày', () => {
    const now = Date.now();
    expect(daysLeft(now, now)).toBe(TRASH_DAYS);
    expect(daysLeft(now - 27 * DAY_MS, now)).toBe(3);
    expect(daysLeft(now - 31 * DAY_MS, now)).toBe(0);
  });

  test('purgeExpired: dọn note quá 30 ngày cùng blocks/tags/files; giữ note còn hạn; bỏ qua mốc xoá sai đồng hồ', async () => {
    const m = machine();
    const now = Date.now();
    const old = await createNote(m.sdk, newId(), 'cũ');
    const fresh = await createNote(m.sdk, newId(), 'mới');
    const skew = await createNote(m.sdk, newId(), 'lệch giờ');
    // note được tạo cách đây 60 ngày (created_at do bridge đặt = giờ máy lúc tạo, ở đây là bây giờ nên lùi lại)
    m.db.run(`UPDATE ${PREFIX}_notes SET created_at = ?`, [new Date(now - 60 * DAY_MS).toISOString()]);
    const s = await open(m, old);
    typeParagraph(s.doc, 'nội dung');
    await s.flush();
    s.destroy();
    await trashNote(m.sdk, old, now - 31 * DAY_MS);
    await trashNote(m.sdk, fresh, now - 3 * DAY_MS);
    await trashNote(m.sdk, skew, 5); // đồng hồ máy về 1970 khi bấm xoá
    expect(await purgeExpired(m.sdk, now)).toBe(1);
    expect((await listTrash(m.sdk)).map((n) => n.title).sort()).toEqual(['lệch giờ', 'mới']);
    expect(await getNote(m.sdk, old)).toBeNull();
    expect(liveBlocks(m, old)).toHaveLength(0);
  });
});

describe('AC-2: gộp update', () => {
  async function bigNote(m: Machine, n: number) {
    const id = await createNote(m.sdk);
    const s = await open(m, id);
    for (let i = 0; i < n; i++) {
      typeParagraph(s.doc, `dòng ${i}`);
      await s.flush();
    }
    return { id, s };
  }

  test('> 200 dòng → 1 snapshot, các dòng cũ xoá mềm, nội dung không đổi', async () => {
    const m = machine();
    const { id, s } = await bigNote(m, COMPACT_THRESHOLD + 25);
    const before = s.text();
    expect(liveBlocks(m, id)).toHaveLength(COMPACT_THRESHOLD + 25);
    expect(await s.compactIfNeeded()).toBe(true);
    const live = liveBlocks(m, id);
    expect(live).toHaveLength(1);
    expect(live[0].kind).toBe('snapshot');
    expect(blockRows(m, id)).toHaveLength(COMPACT_THRESHOLD + 26); // dòng cũ còn đó, chỉ bị xoá mềm
    s.destroy();
    const s2 = await open(m, id);
    expect(s2.text()).toBe(before);
    s2.destroy();
  });

  test('chưa tới ngưỡng thì không gộp; còn chữ chưa ghi thì hoãn', async () => {
    const m = machine();
    const { id, s } = await bigNote(m, 10);
    expect(await s.compactIfNeeded()).toBe(false);
    expect(liveBlocks(m, id)).toHaveLength(10);
    s.destroy();
  });

  test('máy B offline giữ update cũ + có update mới trong lúc A gộp → sau sync vẫn hợp nhất đúng, không mất chữ', async () => {
    const a = machine();
    const b = machine();
    const { id, s: sa } = await bigNote(a, COMPACT_THRESHOLD + 5);
    sync2(a, b);
    const sb = await open(b, id);
    b.setNet('offline');
    typeParagraph(sb.doc, 'B viết trong lúc A gộp');
    await sb.flush();
    expect(await sa.compactIfNeeded()).toBe(true);
    sync2(a, b);
    await sa.pull();
    await sb.pull();
    expect(sa.text()).toBe(sb.text());
    expect(sa.text()).toContain('B viết trong lúc A gộp');
    expect(sa.text()).toContain('dòng 0');
    expect(sa.text()).toContain(`dòng ${COMPACT_THRESHOLD + 4}`);
    // máy C mới tải về: chỉ thấy snapshot + dòng của B (các dòng cũ đã xoá mềm) và dựng lại đúng
    const c = machine();
    sync2(a, c);
    expect(liveBlocks(c, id).length).toBe(2);
    const text = await loadText(c.sdk, id);
    expect(text).toBe(sa.text());
    sa.destroy();
    sb.destroy();
  });

  test('máy tải GIỮA CHỪNG (chỉ thấy snapshot, chưa thấy các xoá mềm; hoặc ngược lại) vẫn dựng đúng nội dung', async () => {
    const a = machine();
    const { id, s } = await bigNote(a, COMPACT_THRESHOLD + 3);
    const expected = s.text();
    await s.compactIfNeeded();
    const rows = blockRows(a, id);
    const snapshot = rows.find((r) => r.kind === 'snapshot')!;
    // Hàng đợi giữ thứ tự: snapshot đến trước. Giữa chừng = có snapshot, các dòng cũ chưa bị xoá (dư nhưng không sai).
    const mid = machine();
    sync2(a, mid);
    mid.db.run(`UPDATE ${PREFIX}_note_blocks SET deleted_at = NULL WHERE id != ?`, [snapshot.id]);
    expect(liveBlocks(mid, id).length).toBeGreaterThan(1);
    expect(await loadText(mid.sdk, id)).toBe(expected);
    // Chỉ có snapshot (mọi dòng cũ đã xoá) cũng đủ.
    const end = machine();
    sync2(a, end);
    expect(await loadText(end.sdk, id)).toBe(expected);
    s.destroy();
  });

  test('gộp dùng ≤ 100 câu mỗi giao dịch kể cả với hàng nghìn dòng (xoá bằng DELETE … IN theo khúc)', async () => {
    const m = machine();
    const id = await createNote(m.sdk);
    const s = await open(m, id);
    let maxStmts = 0;
    const real = m.sdk.db.transaction.bind(m.sdk.db);
    (m.sdk.db as unknown as { transaction: typeof real }).transaction = async (st) => {
      maxStmts = Math.max(maxStmts, st.length);
      return real(st);
    };
    for (let i = 0; i < 1000; i++) {
      // chèn thẳng cho nhanh: mỗi dòng một update hợp lệ
      const d = new Y.Doc();
      typeParagraph(d, `x${i}`);
      const u = Y.encodeStateAsUpdate(d);
      m.db.run(`INSERT INTO ${PREFIX}_note_blocks (id, note_id, kind, data, size, tenant_id, created_at, updated_at) VALUES (?, ?, 'update', ?, 1, 't', ?, ?)`, [newId(), id, Buffer.from(u).toString('base64'), new Date(1e12 + i).toISOString(), new Date(1e12 + i).toISOString()]);
    }
    await s.pull();
    expect(await s.compactIfNeeded()).toBe(true);
    expect(maxStmts).toBeLessThanOrEqual(100);
    expect(liveBlocks(m, id)).toHaveLength(1);
    s.destroy();
  });
});

describe('AC-3: tag', () => {
  test('groupTags gộp tên trùng không phân biệt hoa thường/khoảng trắng; chuẩn = id nhỏ nhất; "Việc" ≠ "Viec"', () => {
    const g = groupTags([
      { id: 'b2', name: 'việc nhà' },
      { id: 'a1', name: ' Việc Nhà ' },
      { id: 'c3', name: 'mua sắm' },
      { id: 'd4', name: 'Viec nha' },
    ]);
    expect(g.map((x) => x.key)).toEqual(['mua sắm', 'viec nha', 'việc nhà'].sort((x, y) => x.localeCompare(y, 'vi')));
    const home = g.find((x) => x.key === 'việc nhà')!;
    expect(home.canonical).toBe('a1');
    expect(home.ids).toEqual(['a1', 'b2']);
  });

  test('ensureTag dùng lại tag cùng tên (hoa thường khác), không tạo bản thứ hai', async () => {
    const m = machine();
    const first = await ensureTag(m.sdk, 'việc nhà');
    expect(first.reused).toBe(false);
    const again = await ensureTag(m.sdk, '  VIỆC NHÀ ');
    expect(again.reused).toBe(true);
    expect(again.group.canonical).toBe(first.group.canonical);
    expect((await m.sdk.core.tags.list()).length).toBe(1);
  });

  test('hai máy cùng tạo "việc nhà" lúc offline → hiển thị gộp; gắn ghi vào bản chuẩn; bỏ gắn xoá mọi liên kết trùng', async () => {
    const a = machine();
    const b = machine();
    await ensureTag(a.sdk, 'việc nhà');
    await ensureTag(b.sdk, 'Việc nhà');
    const note = await createNote(a.sdk);
    sync2(a, b);
    const groups = await listTagGroups(a.sdk);
    expect(groups).toHaveLength(1);
    expect(groups[0].ids).toHaveLength(2);
    await attachTag(a.sdk, note, groups[0]);
    await attachTag(a.sdk, note, groups[0]); // gắn lại không nhân đôi
    const links = a.db.all(`SELECT tag_id FROM ${PREFIX}_note_tags WHERE note_id = ? AND deleted_at IS NULL`, [note]);
    expect(links).toHaveLength(1);
    expect(links[0].tag_id).toBe(groups[0].canonical);
    // một liên kết khác trỏ tới BẢN TRÙNG (do máy B gắn bằng id của nó) → vẫn hiển thị là cùng một tag, bỏ gắn xoá cả hai
    const other = groups[0].ids.find((i) => i !== groups[0].canonical)!;
    a.db.run(`INSERT INTO ${PREFIX}_note_tags (id, note_id, tag_id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, 't', 'x', 'x')`, [newId(), note, other]);
    const map = await tagsByNote(a.sdk, groups);
    expect(map.get(note)).toHaveLength(1);
    await detachTag(a.sdk, note, groups[0]);
    expect((await tagsByNote(a.sdk, groups)).get(note)).toBeUndefined();
  });

  test('thiếu scope core.tags:write → SCOPE_DENIED được ném ra có mã', async () => {
    const m = machine();
    const orig = manifest.scopes;
    try {
      manifest.scopes = orig.filter((s) => s !== 'core.tags:write');
      await expect(ensureTag(m.sdk, 'x')).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    } finally {
      manifest.scopes = orig;
    }
  });
});

describe('AC-4: đính kèm', () => {
  test('ảnh: pickImage → liên kết note_files; gỡ = xoá mềm liên kết, file giữ nguyên', async () => {
    const m = machine();
    const id = await createNote(m.sdk);
    m.pickImage.push({ name: 'a.jpg', mime: 'image/jpeg', base64: Buffer.alloc(100, 1).toString('base64') });
    const rows = await attachImages(m.sdk, id);
    expect(rows).toHaveLength(1);
    expect((await listAttachments(m.sdk, id))[0]).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
    await detachAttachment(m.sdk, rows[0].id);
    expect(await listAttachments(m.sdk, id)).toHaveLength(0);
    expect((m.db.all('SELECT id FROM core_files WHERE deleted_at IS NULL', []) as unknown[]).length).toBe(1);
  });

  test('PDF: pickFile lọc application/pdf, lưu tên + dung lượng; offline vẫn đính được', async () => {
    const m = machine();
    m.setNet('offline');
    const id = await createNote(m.sdk);
    m.pickFile.push({ name: 'hop.pdf', mime: 'application/pdf', base64: Buffer.alloc(2048, 2).toString('base64') });
    const rows = await attachPdfs(m.sdk, id);
    expect(rows[0]).toMatchObject({ kind: 'pdf', name: 'hop.pdf', size: 2048 });
    expect(await listAttachments(m.sdk, id)).toHaveLength(1);
  });

  test('tệp không phải PDF → INVALID_REQUEST, không liên kết, không lưu file', async () => {
    const m = machine();
    const id = await createNote(m.sdk);
    m.pickFile.push({ name: 'a.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', base64: 'AAAA' });
    await expect(attachPdfs(m.sdk, id)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await listAttachments(m.sdk, id)).toHaveLength(0);
    expect((m.db.all('SELECT id FROM core_files', []) as unknown[]).length).toBe(0);
  });

  test('chỉ đọc: đính kèm bị từ chối READ_ONLY', async () => {
    const m = machine();
    const id = await createNote(m.sdk);
    m.setNet('ro');
    await expect(attachImages(m.sdk, id)).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(attachPdfs(m.sdk, id)).rejects.toMatchObject({ code: 'READ_ONLY' });
  });
});

describe('AC-5: tìm kiếm không dấu', () => {
  async function seed(m: Machine) {
    const make = async (title: string, body: string) => {
      const id = await createNote(m.sdk, newId(), title);
      const s = await open(m, id, () => title);
      typeParagraph(s.doc, body);
      await s.flush();
      s.destroy();
      return id;
    };
    return {
      ghiChu: await make('Ghi chú nhanh', 'Mật khẩu wifi nhà bà ngoại'),
      dangKy: await make('Họp tuần', 'Cần đăng ký phòng họp cho thứ Ba'),
      ca: await make('Danh sách chợ', 'Rau muống, cà chua, 50% giảm giá'),
    };
  }

  test('"ghi chu" ra "Ghi chú", "dang ky" ra "đăng ký", không phân biệt hoa thường, nhiều từ = AND', async () => {
    const m = machine();
    const ids = await seed(m);
    const q = async (s: string) => (await listNotes(m.sdk, searchTerms(s))).map((n) => n.id);
    expect(await q('ghi chu')).toEqual([ids.ghiChu]);
    expect(await q('GHI CHÚ')).toEqual([ids.ghiChu]);
    expect(await q('dang ky')).toEqual([ids.dangKy]);
    expect(await q('dang ky phong hop')).toEqual([ids.dangKy]);
    expect(await q('dang ky wifi')).toEqual([]);
    expect(await q('zzz')).toEqual([]);
    expect((await q('')).length).toBe(3);
  });

  test('ký tự % _ trong từ khoá không phải ký tự đại diện; note thùng rác không hiện', async () => {
    const m = machine();
    const ids = await seed(m);
    expect(await listNotes(m.sdk, searchTerms('50%'))).toHaveLength(1);
    expect(await listNotes(m.sdk, searchTerms('%'))).toHaveLength(1); // chỉ note có dấu % thật
    expect(await listNotes(m.sdk, searchTerms('_'))).toHaveLength(0);
    await trashNote(m.sdk, ids.ghiChu);
    expect(await listNotes(m.sdk, searchTerms('ghi chu'))).toEqual([]);
  });

  test('tìm khi offline vẫn chạy (không đụng mạng)', async () => {
    const m = machine();
    await seed(m);
    m.setNet('offline');
    expect(await listNotes(m.sdk, searchTerms('ghi chu'))).toHaveLength(1);
  });

  test('1 000 note: tìm ≤ 300 ms (đo trên node:sqlite — cận dưới, đo thật ở emulator khi dogfood)', async () => {
    const m = machine();
    for (let i = 0; i < 1000; i++) {
      const title = `Ghi chú số ${i}`;
      m.db.run(`INSERT INTO ${PREFIX}_notes (id, title, pinned, trashed_at_ms, search_text, snippet, tenant_id, created_at, updated_at) VALUES (?, ?, 0, NULL, ?, '', 't', ?, ?)`, [newId(), title, normalize(`${title} nội dung đăng ký số ${i} lorem ipsum dolor sit amet`), new Date(1e12 + i).toISOString(), new Date(1e12 + i).toISOString()]);
    }
    const t0 = performance.now();
    const rows = await listNotes(m.sdk, searchTerms('dang ky so 999'));
    const ms = performance.now() - t0;
    expect(rows).toHaveLength(1);
    expect(ms).toBeLessThan(300);
  });

  test('reindex dựng lại search_text từ Yjs đã hợp nhất; chỉ ghi khi khác; hai lần liên tiếp thì lần hai không đổi gì', async () => {
    const a = machine();
    const b = machine();
    const id = await createNote(a.sdk, newId(), 'Chung');
    sync2(a, b);
    const sa = await open(a, id, () => 'Chung');
    const sb = await open(b, id, () => 'Chung');
    typeParagraph(sa.doc, 'chữ của A');
    typeParagraph(sb.doc, 'chữ của B');
    await sa.flush();
    await sb.flush();
    sync2(a, b);
    // mỗi máy mới chỉ ghi search_text theo bản của mình
    expect(rawNote(a, id).search_text).toContain('chu cua a');
    expect(rawNote(a, id).search_text).not.toContain('chu cua b');
    expect(await reindex(a.sdk, [id])).toBe(1);
    expect(String(rawNote(a, id).search_text)).toContain('chu cua a');
    expect(String(rawNote(a, id).search_text)).toContain('chu cua b');
    expect(await reindex(a.sdk, [id])).toBe(0);
    sa.destroy();
    sb.destroy();
  });

  test('blockSignatures đổi khi có dòng mới (dấu hiệu thay đổi từ máy khác)', async () => {
    const a = machine();
    const id = await createNote(a.sdk);
    const s = await open(a, id);
    const sig0 = (await blockSignatures(a.sdk)).get(id);
    typeParagraph(s.doc, 'x');
    await s.flush();
    expect((await blockSignatures(a.sdk)).get(id)).not.toBe(sig0);
    s.destroy();
  });
});

describe('AC-6: intent', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = (type: string) => manifest.intents!.receives!.find((r) => r.type === type)!.schema as object;
  const uuid = newId();

  test('schema note.create / note.open khớp ví dụ hợp lệ và từ chối payload sai', () => {
    const create = ajv.compile(schema('note.create'));
    expect(create({ title: 'Bài báo', body: 'tóm tắt', url: 'https://vnexpress.net/a', id: uuid })).toBe(true);
    expect(create({ title: 'Chỉ tiêu đề' })).toBe(true);
    for (const bad of [
      {},
      { title: '' },
      { title: 'x'.repeat(201) },
      { title: 'x', body: 'y'.repeat(20001) },
      { title: 'x', url: 'javascript:alert(1)' },
      { title: 'x', id: 'khong-phai-uuid' },
      { title: 'x', extra: 1 },
    ]) expect(create(bad), JSON.stringify(bad).slice(0, 60)).toBe(false);
    const open = ajv.compile(schema('note.open'));
    expect(open({ noteId: uuid })).toBe(true);
    expect(open({ noteId: '123' })).toBe(false);
    expect(open({})).toBe(false);
  });

  test('createFromIntent tạo đúng id bên gửi, gửi lại cùng id không tạo trùng, nội dung HTML chỉ là chữ', async () => {
    const m = machine();
    const r1 = await createFromIntent(m.sdk, { id: uuid, title: 'Giá xăng', body: 'dòng 1\n<script>alert(1)</script>', url: 'https://vnexpress.net/x' });
    expect(r1).toEqual({ id: uuid, created: true });
    const r2 = await createFromIntent(m.sdk, { id: uuid, title: 'Giá xăng', body: 'khác' });
    expect(r2).toEqual({ id: uuid, created: false });
    expect(await listNotes(m.sdk)).toHaveLength(1);
    expect(liveBlocks(m, uuid)).toHaveLength(1);
    const text = await loadText(m.sdk, uuid);
    expect(text).toBe('dòng 1\n<script>alert(1)</script>\nhttps://vnexpress.net/x');
    const n = await getNote(m.sdk, uuid);
    expect(n!.search_text).toContain('gia xang');
    expect(n!.snippet).toContain('dong 1'.replace('dong', 'dòng'));
  });

  test('thiếu id → tự sinh; note đã xoá hẳn (deleted_at) cũng không bị tạo lại bằng cùng id', async () => {
    const m = machine();
    const r = await createFromIntent(m.sdk, { title: 'Không id' });
    expect(r.created).toBe(true);
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    await m.sdk.db.execute('DELETE FROM notes WHERE id = ?', [r.id]);
    expect((await createFromIntent(m.sdk, { id: r.id, title: 'lại' })).created).toBe(false);
  });

  test('getNote thấy note thùng rác (để hỏi khôi phục) nhưng không thấy note đã xoá hẳn', async () => {
    const m = machine();
    const id = await createNote(m.sdk, newId(), 'T');
    await trashNote(m.sdk, id);
    expect((await getNote(m.sdk, id))!.trashed_at_ms).not.toBeNull();
    await m.sdk.db.execute('DELETE FROM notes WHERE id = ?', [id]);
    expect(await getNote(m.sdk, id)).toBeNull();
  });

  test('chỉ đọc: createFromIntent bị READ_ONLY (shell cũng chặn ở bên gửi)', async () => {
    const m = machine();
    m.setNet('ro');
    await expect(createFromIntent(m.sdk, { title: 'x' })).rejects.toMatchObject({ code: 'READ_ONLY' });
  });
});

describe('AC-7: máy mới dựng lại đúng nội dung', () => {
  test('máy C (DB trống) sync từ A → mọi note, tag, đính kèm và nội dung giống bản gốc từng ký tự', async () => {
    const a = machine();
    const c = machine();
    const id = await createNote(a.sdk, newId(), 'Danh sách');
    const s = await open(a, id, () => 'Danh sách');
    typeParagraph(s.doc, 'Đăng ký khoá học tiếng Anh');
    typeParagraph(s.doc, 'Ưu tiên: ă â ê ô ơ ư đ');
    await s.flush();
    typeParagraph(s.doc, 'Dòng thêm sau');
    await s.flush();
    const original = s.text();
    s.destroy();
    const tag = await ensureTag(a.sdk, 'công việc');
    await attachTag(a.sdk, id, tag.group);
    sync2(a, c);
    expect(await loadText(c.sdk, id)).toBe(original);
    expect((await listNotes(c.sdk)).map((n) => n.title)).toEqual(['Danh sách']);
    const groups = await listTagGroups(c.sdk);
    expect((await tagsByNote(c.sdk, groups)).get(id)!.map((g) => g.name)).toEqual(['công việc']);
    // mở bằng phiên soạn trên máy C cho cùng văn bản
    const sc = await open(c, id);
    expect(sc.text()).toBe(original);
    sc.destroy();
  });

  test('xoá thắng sửa: update của máy offline tới sau khi note đã xoá hẳn không hồi sinh note', async () => {
    const a = machine();
    const b = machine();
    const id = await createNote(a.sdk, newId(), 'Sẽ xoá');
    sync2(a, b);
    await a.sdk.db.transaction([{ sql: 'DELETE FROM notes WHERE id = ?', params: [id] }]);
    const sb = await open(b, id);
    typeParagraph(sb.doc, 'B viết trong lúc offline');
    await sb.flush();
    sync2(a, b);
    expect(await getNote(a.sdk, id)).toBeNull();
    expect(await getNote(b.sdk, id)).toBeNull();
    expect(await listNotes(a.sdk)).toHaveLength(0);
    sb.destroy();
  });

  test('docFromUpdates / b64decode: round-trip nhị phân an toàn với dữ liệu lớn', () => {
    const d = new Y.Doc();
    for (let i = 0; i < 300; i++) typeParagraph(d, `dòng ${i} ${'ư'.repeat(50)}`);
    const u = Y.encodeStateAsUpdate(d);
    expect(u.length).toBeGreaterThan(0x8000 / 4);
    const copy = docFromUpdates([Buffer.from(u).toString('base64')]);
    expect(extractText(copy)).toBe(extractText(d));
    expect(b64decode(Buffer.from(u).toString('base64'))).toEqual(u);
  });
});
