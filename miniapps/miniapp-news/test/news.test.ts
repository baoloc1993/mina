// AC-1..AC-4 của Đọc báo trên BRIDGE THẬT + mock SDK (giàn test/harness.ts): thêm nguồn, làm mới, đọc sau, dọn 30 ngày, hai máy, intent.
import { describe, expect, test } from 'vitest';
import {
  groupSources, getItem, listItems, listSaved, listSourceNames, listSources, markRead, markUnread, purgeOld, removeSource, renameSource, setNoteId, setSaved, MAX_SOURCES,
} from '../src/data/repo';
import { itemId } from '../src/feed/id';
import { parseIntent, noteCreatePayload, reminderPayload } from '../src/intent/intents';
import { addSource, AppError, packError, refreshAll, refreshSource, unpackError } from '../src/sources/refresh';
import { errCode } from '../src/sdk';
import { feedFile, machine, sync2, type Machine } from './harness';

const VNE = 'https://vnexpress.net/rss/tin-moi-nhat.rss';
const TT = 'https://tuoitre.vn/rss/tin-moi-nhat.rss';
const BLOG = 'https://blog.example.dev/rss.xml';
const DAY = 86_400_000;
const rssOf = (title: string, items: [string, string][]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${items.map(([g, t]) => `<item><title>${t}</title><link>https://blog.example.dev/${g}</link><guid>${g}</guid><pubDate>Fri, 09 Oct 2026 10:00:00 +0700</pubDate></item>`).join('')}</channel></rss>`;

function serve(m: Machine, url: string, body: string, status = 200) {
  m.web.set(url, { status, body });
}
const count = (m: Machine, table: string, live = true) => (m.db.all(`SELECT COUNT(*) AS n FROM app_vn_app_news_${table}${live ? ' WHERE deleted_at IS NULL' : ''}`, [])[0] as { n: number }).n;
const grants = (m: Machine) => m.db.all('SELECT host FROM core_net_grants WHERE deleted_at IS NULL ORDER BY host', []).map((r) => String(r.host));
async function add(m: Machine, url: string, extra: { name?: string; suggestedKey?: string } = {}) {
  return addSource(m.sdk, url, { groups: groupSources(await listSources(m.sdk)), now: m.clock.now, ...extra });
}
const reject = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('đáng lẽ phải ném lỗi');
};

describe('AC-1 thêm nguồn', () => {
  test('nguồn gợi ý (host ∈ config.network): không hỏi quyền, tải + lưu nguồn và 6 bài, tên theo gợi ý', async () => {
    const m = machine();
    m.config.value = { network: ['vnexpress.net'] };
    serve(m, VNE, feedFile('vnexpress.xml'));
    const r = await add(m, VNE, { name: 'VnExpress', suggestedKey: 'vnexpress' });
    expect(r).toMatchObject({ status: 'added', added: 6, source: { name: 'VnExpress', host: 'vnexpress.net', suggested_key: 'vnexpress' } });
    expect(m.asked).toEqual([]);
    expect(grants(m)).toEqual([]);
    expect(count(m, 'sources')).toBe(1);
    expect(count(m, 'items')).toBe(6);
    expect(m.hops).toEqual([VNE]);
  });
  test('dán URL host mới: hộp thoại hỏi 1 lần (kèm lý do) → Cho phép → ghi grant, lưu nguồn với tên lấy từ <title>', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('Blog của Tùng', [['a', 'Bài A'], ['b', 'Bài B']]));
    const r = await add(m, 'blog.example.dev/rss.xml');
    expect(r).toMatchObject({ status: 'added', added: 2, source: { name: 'Blog của Tùng', feed_url: BLOG } });
    expect(m.asked).toEqual([{ host: 'blog.example.dev', reason: 'Để tải tin từ blog.example.dev' }]);
    expect(grants(m)).toEqual(['blog.example.dev']);
  });
  test('từ chối quyền: NET_BLOCKED "Chưa cho phép…", KHÔNG lưu gì, KHÔNG request nào rời máy; dán lại + cho phép thì lưu', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('Blog', [['a', 'A']]));
    m.answer.value = false;
    const e = await reject(add(m, BLOG));
    expect([e.code, e.message]).toEqual(['NET_BLOCKED', 'Chưa cho phép truy cập blog.example.dev. Chưa lưu.']);
    expect([count(m, 'sources'), count(m, 'items'), grants(m).length, m.hops.length]).toEqual([0, 0, 0, 0]);
    m.answer.value = true;
    expect((await add(m, BLOG)).status).toBe('added');
    expect(m.asked).toHaveLength(2);
  });
  test.each([
    ['trang HTML', { body: '<!doctype html><html><body>Trang chủ</body></html>' }, 'INVALID_REQUEST', 'Không phải RSS/Atom — dán đúng địa chỉ feed'],
    ['404', { status: 404, body: 'x' }, 'NET_ERROR', 'Trang trả về 404'],
    ['503', { status: 503, body: 'x' }, 'NET_ERROR', 'Trang trả về 503'],
    ['XML hỏng', { body: '<rss><channel><item>' }, 'INVALID_REQUEST', 'Không phải RSS/Atom — dán đúng địa chỉ feed'],
  ])('%s → lỗi có mã, không lưu gì', async (_n, page, code, message) => {
    const m = machine();
    m.web.set(BLOG, page);
    const e = await reject(add(m, BLOG));
    expect([e.code, e.message]).toEqual([code, message]);
    expect([count(m, 'sources'), count(m, 'items')]).toEqual([0, 0]);
  });
  test('offline: OFFLINE, không lưu (nhưng vẫn hỏi và ghi được grant)', async () => {
    const m = machine();
    m.setNet('offline');
    const e = await reject(add(m, BLOG));
    expect(e.code).toBe('OFFLINE');
    expect(count(m, 'sources')).toBe(0);
    expect(grants(m)).toEqual(['blog.example.dev']);
  });
  test('chuyển hướng sang host khác (a.vn → www.a.vn): NET_BLOCKED + câu hướng dẫn, không request nào tới host thứ hai, không tự xin quyền host đó', async () => {
    const m = machine();
    m.web.set('https://a.vn/rss', { status: 301, headers: { location: 'https://www.a.vn/rss' } });
    serve(m, 'https://www.a.vn/rss', rssOf('A', [['a', 'A']]));
    const e = await reject(add(m, 'https://a.vn/rss'));
    expect([e.code, e.message]).toEqual(['NET_BLOCKED', 'Trang chuyển sang www.a.vn — thêm lại bằng địa chỉ đó']);
    expect(m.hops).toEqual(['https://a.vn/rss']);
    expect(m.asked).toHaveLength(1);
    expect(count(m, 'sources')).toBe(0);
  });
  test('http → https cùng host: được', async () => {
    const m = machine();
    m.web.set('http://a.vn/rss', { status: 301, headers: { location: 'https://a.vn/rss' } });
    serve(m, 'https://a.vn/rss', rssOf('A', [['a', 'A']]));
    expect((await add(m, 'http://a.vn/rss')).status).toBe('added');
  });
  test('cùng feed_url đã có → "exists" (chọn nguồn cũ), không hỏi quyền, không tải', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('Blog', [['a', 'A']]));
    const first = await add(m, BLOG);
    m.hops.length = 0;
    m.asked.length = 0;
    const again = await add(m, 'blog.example.dev/rss.xml#top');
    expect(again.status).toBe('exists');
    expect(again.source.id).toBe(first.source.id);
    expect([m.hops.length, m.asked.length, count(m, 'sources')]).toEqual([0, 0, 1]);
  });
  test(`tối đa ${MAX_SOURCES} nguồn`, async () => {
    const m = machine();
    for (let i = 0; i < MAX_SOURCES; i++) {
      serve(m, `https://s${i}.example.vn/rss`, rssOf(`S${i}`, [['a', 'A']]));
      await add(m, `https://s${i}.example.vn/rss`);
    }
    const e = await reject(add(m, 'https://s99.example.vn/rss'));
    expect(e.message).toBe(`Tối đa ${MAX_SOURCES} nguồn — bỏ bớt một nguồn rồi thêm lại`);
    expect(count(m, 'sources')).toBe(MAX_SOURCES);
  });
  test('URL sai (ftp, user:pass@, rỗng) bị chặn trước khi hỏi quyền hay tải', async () => {
    const m = machine();
    for (const bad of ['', 'ftp://a.vn/x', 'https://u:p@a.vn/rss', 'javascript:alert(1)']) expect((await reject(add(m, bad))).code).toBe('INVALID_REQUEST');
    expect([m.asked.length, m.hops.length]).toEqual([0, 0]);
  });
  test('bỏ nguồn: nguồn + bài CHƯA đọc sau xoá mềm; bài đọc sau giữ và hiện tên "nguồn đã bỏ"', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('Blog', [['a', 'A'], ['b', 'B'], ['c', 'C']]));
    const r = await add(m, BLOG);
    const items = await listItems(m.sdk);
    await setSaved(m.sdk, items[0].id, m.clock.now);
    await removeSource(m.sdk, [r.source.id]);
    expect(await listSources(m.sdk)).toEqual([]);
    expect((await listItems(m.sdk)).map((i) => i.id)).toEqual([items[0].id]);
    expect((await listSaved(m.sdk)).map((i) => i.id)).toEqual([items[0].id]);
    expect((await listSourceNames(m.sdk)).get(r.source.id)).toMatchObject({ name: 'Blog', deleted: true });
  });
  test('đổi tên nguồn', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('Blog', [['a', 'A']]));
    const r = await add(m, BLOG);
    await renameSource(m.sdk, [r.source.id], 'Blog của tôi');
    expect((await listSources(m.sdk))[0].name).toBe('Blog của tôi');
  });
  test('thêm lại nguồn đã bỏ: nguồn mới (id mới); bài đã xoá mềm không hồi sinh nên bài lấy id kế tiếp, không trùng, không lỗi khoá', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('Blog', [['a', 'A'], ['b', 'B']]));
    const first = await add(m, BLOG);
    const old = (await listItems(m.sdk)).map((i) => i.id).sort();
    await removeSource(m.sdk, [first.source.id]);
    const second = await add(m, BLOG);
    expect(second.source.id).not.toBe(first.source.id);
    const now = (await listItems(m.sdk)).map((i) => i.id).sort();
    expect(now).toHaveLength(2);
    expect(now.some((id) => old.includes(id))).toBe(false);
    expect(now).toEqual([itemId('mock-tenant', BLOG, 'a', 1), itemId('mock-tenant', BLOG, 'b', 1)].sort());
    // bỏ lần nữa rồi thêm lần ba → gen 2
    await removeSource(m.sdk, [second.source.id]);
    await add(m, BLOG);
    expect((await listItems(m.sdk)).map((i) => i.id).sort()).toEqual([itemId('mock-tenant', BLOG, 'a', 2), itemId('mock-tenant', BLOG, 'b', 2)].sort());
  });
});

describe('AC-2 làm mới + đọc tin', () => {
  async function twoSources(m: Machine) {
    m.config.value = { network: ['vnexpress.net', 'tuoitre.vn'] };
    serve(m, VNE, feedFile('vnexpress.xml'));
    serve(m, TT, feedFile('tuoitre.xml'));
    await add(m, VNE, { name: 'VnExpress' });
    await add(m, TT, { name: 'Tuổi Trẻ' });
    return groupSources(await listSources(m.sdk));
  }
  test('gộp bài theo thời gian giảm dần, hai nguồn; làm mới lần hai không nhân đôi', async () => {
    const m = machine();
    const groups = await twoSources(m);
    expect(count(m, 'items')).toBe(12);
    const out = await refreshAll(m.sdk, groups, m.clock.now);
    expect(out.every((o) => o.ok && o.added === 0)).toBe(true);
    const items = await listItems(m.sdk);
    expect(items).toHaveLength(12);
    const times = items.map((i) => i.published_at_ms ?? i.fetched_at_ms);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
  test('bài mới trong feed được thêm; bài rời feed vẫn giữ; tiêu đề đổi thì cập nhật', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('B', [['a', 'A'], ['b', 'B']]));
    await add(m, BLOG);
    const g = groupSources(await listSources(m.sdk));
    serve(m, BLOG, rssOf('B', [['c', 'C mới'], ['b', 'B đã sửa tiêu đề']]));
    m.clock.now += 3600_000;
    const [o] = await refreshAll(m.sdk, g, m.clock.now);
    expect(o).toMatchObject({ ok: true, added: 1 });
    const titles = (await listItems(m.sdk)).map((i) => i.title).sort();
    expect(titles).toEqual(['A', 'B đã sửa tiêu đề', 'C mới']);
  });
  test('một nguồn lỗi (503) không chặn nguồn khác; last_error ghi cho nguồn đó và xoá khi thành công', async () => {
    const m = machine();
    const groups = await twoSources(m);
    serve(m, TT, 'lỗi', 503);
    const out = await refreshAll(m.sdk, groups, m.clock.now + 1000);
    expect(out.filter((o) => o.ok)).toHaveLength(1);
    const bad = (await listSources(m.sdk)).find((s) => s.feed_url === TT)!;
    expect(unpackError(bad.last_error)).toEqual({ code: 'NET_ERROR', message: 'Trang trả về 503' });
    expect((await listSources(m.sdk)).find((s) => s.feed_url === VNE)!.last_error).toBeNull();
    serve(m, TT, feedFile('tuoitre.xml'));
    await refreshSource(m.sdk, groupSources(await listSources(m.sdk)).find((g) => g.main.feed_url === TT)!, m.clock.now + 2000);
    expect((await listSources(m.sdk)).find((s) => s.feed_url === TT)!.last_error).toBeNull();
  });
  test('offline: OFFLINE cho mọi nguồn, KHÔNG ghi gì vào DB (giữ danh sách + lần cập nhật cuối)', async () => {
    const m = machine();
    const groups = await twoSources(m);
    const before = JSON.stringify(m.db.all('SELECT * FROM app_vn_app_news_sources ORDER BY id', []));
    m.setNet('offline');
    const out = await refreshAll(m.sdk, groups, m.clock.now + 5000);
    expect(out.map((o) => o.error?.code)).toEqual(['OFFLINE', 'OFFLINE']);
    expect(JSON.stringify(m.db.all('SELECT * FROM app_vn_app_news_sources ORDER BY id', []))).toBe(before);
    expect(count(m, 'items')).toBe(12);
  });
  test('grant bị thu hồi → NET_BLOCKED "bấm để cho phép lại" ghi vào nguồn đó; cho phép lại thì tải được', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('B', [['a', 'A']]));
    await add(m, BLOG);
    m.db.run("UPDATE core_net_grants SET deleted_at = '2026-10-09' WHERE host = 'blog.example.dev'", []);
    const g = groupSources(await listSources(m.sdk))[0];
    const [o] = await refreshAll(m.sdk, [g], m.clock.now + 1000);
    expect(o.error).toMatchObject({ code: 'NET_BLOCKED', message: 'Chưa được phép truy cập blog.example.dev — bấm để cho phép lại' });
    expect(unpackError((await listSources(m.sdk))[0].last_error)?.code).toBe('NET_BLOCKED');
    expect(m.hops.filter((h) => h === BLOG)).toHaveLength(1); // chỉ lần thêm nguồn; lần làm mới bị chặn trước khi gửi
    expect((await m.sdk.net.requestAccess({ host: 'blog.example.dev' })).granted).toBe(true);
    const [ok] = await refreshAll(m.sdk, [g], m.clock.now + 2000);
    expect(ok.ok).toBe(true);
    expect((await listSources(m.sdk))[0].last_error).toBeNull();
  });
  test('đánh dấu đã đọc / chưa đọc; làm mới KHÔNG đụng read_at_ms / saved_at_ms / note_id', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('B', [['a', 'A'], ['b', 'B']]));
    await add(m, BLOG);
    const [first] = await listItems(m.sdk);
    await markRead(m.sdk, first.id, 1_760_000_000_000);
    await setSaved(m.sdk, first.id, 1_760_000_001_000);
    await setNoteId(m.sdk, first.id, '123e4567-e89b-42d3-a456-426614174000');
    await markRead(m.sdk, first.id, 1_770_000_000_000); // đọc lần hai không đè mốc đầu
    m.clock.now += 2 * DAY;
    await refreshAll(m.sdk, groupSources(await listSources(m.sdk)), m.clock.now);
    const row = (await getItem(m.sdk, first.id))!;
    expect([row.read_at_ms, row.saved_at_ms, row.note_id]).toEqual([1_760_000_000_000, 1_760_000_001_000, '123e4567-e89b-42d3-a456-426614174000']);
    await markUnread(m.sdk, first.id);
    expect((await getItem(m.sdk, first.id))!.read_at_ms).toBeNull();
  });
  test('chỉ UPDATE fetched_at_ms khi cũ hơn 1 ngày (không đẩy PATCH mỗi lần bấm Làm mới)', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('B', [['a', 'A']]));
    await add(m, BLOG);
    const f0 = (await listItems(m.sdk))[0].fetched_at_ms;
    await refreshAll(m.sdk, groupSources(await listSources(m.sdk)), m.clock.now + 3600_000);
    expect((await listItems(m.sdk))[0].fetched_at_ms).toBe(f0);
    await refreshAll(m.sdk, groupSources(await listSources(m.sdk)), m.clock.now + 2 * DAY);
    expect((await listItems(m.sdk))[0].fetched_at_ms).toBe(m.clock.now + 2 * DAY);
  });
  test('hai máy tải cùng bài → cùng id, SAU ĐỒNG BỘ chỉ một dòng mỗi bài; đã đọc ở máy A hiện ở máy B', async () => {
    const a = machine();
    const b = machine();
    for (const m of [a, b]) serve(m, BLOG, rssOf('B', [['x', 'X'], ['y', 'Y']]));
    await add(a, BLOG);
    sync2(a, b); // B nhận nguồn của A trước khi tải
    await refreshAll(b.sdk, groupSources(await listSources(b.sdk)), b.clock.now + 1000);
    expect(count(b, 'items')).toBe(2);
    const [x] = await listItems(a.sdk);
    await markRead(a.sdk, x.id, 1_760_000_000_000);
    sync2(a, b);
    expect((await getItem(b.sdk, x.id))!.read_at_ms).toBe(1_760_000_000_000);
    expect([count(a, 'items'), count(b, 'items')]).toEqual([2, 2]);
  });
  test('hai máy cùng thêm một feed khi offline: hai dòng nguồn → gộp hiển thị id nhỏ nhất; bài vẫn cùng id', async () => {
    const a = machine();
    const b = machine();
    for (const m of [a, b]) serve(m, BLOG, rssOf('B', [['x', 'X'], ['y', 'Y']]));
    const ra = await add(a, BLOG);
    const rb = await add(b, BLOG);
    sync2(a, b);
    expect(count(a, 'sources')).toBe(2);
    const groups = groupSources(await listSources(a.sdk));
    expect(groups).toHaveLength(1);
    expect(groups[0].main.id).toBe([ra.source.id, rb.source.id].sort()[0]);
    expect(groups[0].ids).toHaveLength(2);
    expect(count(a, 'items')).toBe(2); // id tất định: không nhân đôi
    await removeSource(a.sdk, groups[0].ids); // "Bỏ" xoá mọi bản trùng
    expect(groupSources(await listSources(a.sdk))).toEqual([]);
  });
  test('news.open: id thật → tìm được bài; id lạ/không phải UUID → không', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('B', [['x', 'X']]));
    await add(m, BLOG);
    const [x] = await listItems(m.sdk);
    expect(parseIntent('news.open', { itemId: x.id })).toEqual({ kind: 'news.open', itemId: x.id });
    expect(await getItem(m.sdk, '00000000-0000-4000-8000-000000000000')).toBeNull();
    for (const p of [{ itemId: 'abc' }, {}, { itemId: 5 }, null]) expect(parseIntent('news.open', p).kind).toBe('unknown');
    expect(parseIntent('khac', { itemId: x.id }).kind).toBe('unknown');
  });
});

describe('AC-3 đọc sau + dọn 30 ngày', () => {
  async function seeded() {
    const m = machine();
    serve(m, BLOG, rssOf('B', [['a', 'A'], ['b', 'B'], ['c', 'C']]));
    await add(m, BLOG);
    return { m, items: await listItems(m.sdk) };
  }
  test('lưu / bỏ lưu; Đọc sau theo lần lưu mới nhất; chỉ tiêu đề + tóm tắt + link (không cột toàn văn)', async () => {
    const { m, items } = await seeded();
    await setSaved(m.sdk, items[0].id, 1000);
    await setSaved(m.sdk, items[1].id, 2000);
    expect((await listSaved(m.sdk)).map((i) => i.id)).toEqual([items[1].id, items[0].id]);
    await setSaved(m.sdk, items[1].id, null);
    expect((await listSaved(m.sdk)).map((i) => i.id)).toEqual([items[0].id]);
    expect(Object.keys((await listSaved(m.sdk))[0]).sort()).toEqual(['fetched_at_ms', 'guid', 'id', 'image_url', 'link', 'note_id', 'published_at_ms', 'read_at_ms', 'saved_at_ms', 'source_id', 'summary', 'title']);
  });
  test('dọn: bài > 30 ngày chưa lưu (kể cả đã đọc) bị xoá mềm; bài đọc sau KHÔNG BAO GIỜ bị dọn (kể cả 1 năm); bài mới / mốc tương lai giữ', async () => {
    const { m, items } = await seeded();
    const [a, b, c] = items;
    const now = m.clock.now;
    m.db.run('UPDATE app_vn_app_news_items SET fetched_at_ms = ? WHERE id = ?', [now - 31 * DAY, a.id]); // cũ, chưa lưu
    m.db.run('UPDATE app_vn_app_news_items SET fetched_at_ms = ?, saved_at_ms = ? WHERE id = ?', [now - 365 * DAY, now - 365 * DAY, b.id]); // cũ nhưng đọc sau
    m.db.run('UPDATE app_vn_app_news_items SET fetched_at_ms = ? WHERE id = ?', [now + 90 * DAY, c.id]); // đồng hồ máy nhanh → bỏ qua
    await markRead(m.sdk, a.id, now - 40 * DAY);
    expect(await purgeOld(m.sdk, now)).toBe(1);
    expect((await listItems(m.sdk)).map((i) => i.id).sort()).toEqual([b.id, c.id].sort());
    expect(await purgeOld(m.sdk, now + 400 * DAY)).toBe(1); // một năm sau: chỉ c (mốc tương lai nay đã cũ); b vẫn còn
    expect((await listSaved(m.sdk)).map((i) => i.id)).toEqual([b.id]);
  });
  test('dọn tối đa 100 bài mỗi lần mở (UPDATE không có LIMIT) — lần mở sau dọn tiếp', async () => {
    const m = machine();
    for (let i = 0; i < 130; i++) {
      m.db.run(
        'INSERT INTO app_vn_app_news_items (id, source_id, guid, title, summary, link, fetched_at_ms, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [`id-${i}`, 's', `g${i}`, 't', 's', 'https://a.vn/x', m.clock.now - 40 * DAY, 'mock-tenant'],
      );
    }
    expect(await purgeOld(m.sdk, m.clock.now)).toBe(100);
    expect(await purgeOld(m.sdk, m.clock.now)).toBe(30);
    expect(await purgeOld(m.sdk, m.clock.now)).toBe(0);
  });
  test('tắt mạng vẫn đọc được danh sách đã lưu (dữ liệu local)', async () => {
    const { m, items } = await seeded();
    await setSaved(m.sdk, items[0].id, 5);
    m.setNet('offline');
    expect((await listSaved(m.sdk))[0]).toMatchObject({ id: items[0].id, title: items[0].title, link: items[0].link });
  });
  test('hai máy: A lưu → B thấy; xoá mềm từ dọn của máy khác thắng sửa (bài mất khỏi Tin mới)', async () => {
    const a = machine();
    const b = machine();
    for (const m of [a, b]) serve(m, BLOG, rssOf('B', [['x', 'X'], ['y', 'Y']]));
    await add(a, BLOG);
    sync2(a, b);
    const [x] = await listItems(a.sdk);
    await setSaved(a.sdk, x.id, 7);
    sync2(a, b);
    expect((await listSaved(b.sdk)).map((i) => i.id)).toEqual([x.id]);
  });
});

describe('AC-4 intent', () => {
  async function one() {
    const m = machine();
    serve(m, BLOG, rssOf('B', [['x', 'Tiêu đề bài một']]));
    await add(m, BLOG);
    const [it] = await listItems(m.sdk);
    return { m, it };
  }
  test('Lưu thành note: payload hợp schema của Ghi chú (id UUID, title ≤ 200, body = tóm tắt, url = liên kết); gửi lại cùng id', async () => {
    const { m, it } = await one();
    const id = '123e4567-e89b-42d3-a456-426614174000';
    expect(await m.sdk.intent.send('note.create', noteCreatePayload(it, id), { mode: 'create' })).toEqual({ status: 'handled' });
    await setNoteId(m.sdk, it.id, id);
    const again = noteCreatePayload((await getItem(m.sdk, it.id))!, (await getItem(m.sdk, it.id))!.note_id!);
    await m.sdk.intent.send('note.create', again, { mode: 'create' });
    expect(m.intents.map((i) => [i.type, (i.payload as { id: string }).id])).toEqual([['note.create', id], ['note.create', id]]);
    expect(m.intents[0].payload).toMatchObject({ title: 'Tiêu đề bài một', url: 'https://blog.example.dev/x' });
  });
  test('"Đã lưu thành note · Mở": manifest khai sends note.open → shell giao mode open cho Ghi chú (lỗi SCOPE_DENIED ở bản 0.1.2)', async () => {
    const { m } = await one();
    expect(await m.sdk.intent.send('note.open', { noteId: '123e4567-e89b-42d3-a456-426614174000' }, { mode: 'open' })).toEqual({ status: 'opened' });
    expect(m.intents.at(-1)).toMatchObject({ type: 'note.open', mode: 'open', to: 'vn.app.note' });
    m.installed.note = false;
    expect(errCode(await m.sdk.intent.send('note.open', { noteId: '123e4567-e89b-42d3-a456-426614174000' }, { mode: 'open' }).catch((x: unknown) => x))).toBe('INTENT_NO_HANDLER');
  });
  test('tiêu đề 300 ký tự cắt còn 200; không tóm tắt thì bỏ body', async () => {
    const p = noteCreatePayload({ title: 't'.repeat(300), summary: '  ', link: 'https://a.vn/x' }, '123e4567-e89b-42d3-a456-426614174000');
    expect(p.title).toHaveLength(200);
    expect('body' in p).toBe(false);
  });
  test('Ghi chú chưa cài → INTENT_NO_HANDLER, không tạo gì', async () => {
    const { m, it } = await one();
    m.installed.note = false;
    const e = await m.sdk.intent.send('note.create', noteCreatePayload(it, '123e4567-e89b-42d3-a456-426614174000')).catch((x: unknown) => x);
    expect(errCode(e)).toBe('INTENT_NO_HANDLER');
    expect(m.intents).toEqual([]);
  });
  test('Nhắc đọc: payload hợp schema Lịch (at giờ treo, ref trỏ thẳng tới bài); Lịch chưa cài → INTENT_NO_HANDLER', async () => {
    const { m, it } = await one();
    const p = reminderPayload(it, '123e4567-e89b-42d3-a456-426614174001', '2026-10-09T17:00');
    expect(p).toEqual({ id: '123e4567-e89b-42d3-a456-426614174001', title: 'Tiêu đề bài một', at: '2026-10-09T17:00', ref: { app: 'vn.app.news', id: it.id } });
    expect(await m.sdk.intent.send('calendar.reminder.create', p, { mode: 'create' })).toEqual({ status: 'handled' });
    m.installed.calendar = false;
    const e = await m.sdk.intent.send('calendar.reminder.create', p).catch((x: unknown) => x);
    expect(errCode(e)).toBe('INTENT_NO_HANDLER');
  });
  test('payload sai schema bị shell từ chối (INTENT_REJECTED): at sai khuôn', async () => {
    const { m, it } = await one();
    const e = await m.sdk.intent.send('calendar.reminder.create', reminderPayload(it, '123e4567-e89b-42d3-a456-426614174001', 'ngày mai'), { mode: 'create' }).catch((x: unknown) => x);
    expect(errCode(e)).toBe('INTENT_REJECTED');
  });
  test('openUrl: Host nhận đúng liên kết bài; app nền → APP_SUSPENDED', async () => {
    const { m, it } = await one();
    await m.sdk.ui.openUrl(it.link);
    expect(m.opened).toEqual(['https://blog.example.dev/x']);
    m.foreground.value = false;
    expect(errCode(await m.sdk.ui.openUrl(it.link).catch((x: unknown) => x))).toBe('APP_SUSPENDED');
  });
});

describe('chỉ đọc + cấu hình', () => {
  test('chỉ đọc: mọi ghi (thêm nguồn, đọc sau, đánh dấu đọc) → READ_ONLY; đọc vẫn được; xin quyền host vẫn hỏi', async () => {
    const m = machine();
    serve(m, BLOG, rssOf('B', [['x', 'X']]));
    await add(m, BLOG);
    const [it] = await listItems(m.sdk);
    m.setNet('ro');
    expect(errCode(await setSaved(m.sdk, it.id, 5).catch((x: unknown) => x))).toBe('READ_ONLY');
    expect(errCode(await markRead(m.sdk, it.id, 5).catch((x: unknown) => x))).toBe('READ_ONLY');
    serve(m, 'https://khac.vn/rss', rssOf('K', [['k', 'K']]));
    expect(errCode(await add(m, 'https://khac.vn/rss').catch((x: unknown) => x))).toBe('READ_ONLY');
    expect(count(m, 'sources')).toBe(1); // thêm nguồn bị từ chối ở lô ghi: không lưu nửa vời
    expect(await listItems(m.sdk)).toHaveLength(1);
    expect((await m.sdk.net.requestAccess({ host: 'moi.vn' })).granted).toBe(true);
  });
  test('sdk.info().config trả cấu hình từ server (danh sách gợi ý); chưa có → {}', async () => {
    const m = machine();
    expect(((await m.sdk.sdk.info()) as unknown as { config: object }).config).toEqual({});
    m.config.value = { network: ['vnexpress.net'], sources: [{ key: 'vnexpress', name: 'VnExpress', feed_url: VNE, host: 'vnexpress.net' }] };
    expect(((await m.sdk.sdk.info()) as unknown as { config: { sources: unknown[] } }).config.sources).toHaveLength(1);
  });
  test('pack/unpack last_error', () => {
    const e = new AppError('NET_ERROR', 'Trang trả về 404');
    expect(unpackError(packError(e))).toEqual({ code: 'NET_ERROR', message: 'Trang trả về 404' });
    expect(unpackError(null)).toBeNull();
    expect(unpackError('lỗi cũ')).toEqual({ code: 'NET_ERROR', message: 'lỗi cũ' });
  });
});
