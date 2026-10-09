// Phân tích feed (AC-1, AC-2), id tất định, chuẩn hoá URL, thời gian. 3 feed báo VN THẬT chụp lại ngày 2026-10-09 (test/feeds/*.xml).
import { describe, expect, test } from 'vitest';
import { itemId } from '../src/feed/id';
import { NotFeedError, parseDate, parseFeed, stripHtml } from '../src/feed/parse';
import { normalizeFeedUrl, safeHttpUrl } from '../src/feed/url';
import { dayLabel, quickTimes, relTime, wallTime } from '../src/time';
import { feedFile } from './harness';

const NOW = Date.parse('2026-10-09T16:00:00Z'); // 23:00 giờ Việt Nam

describe('3 feed báo thật', () => {
  test.each([
    ['vnexpress.xml', 'Tin mới nhất - VnExpress RSS'],
    ['tuoitre.xml', 'TUOI TRE ONLINE - RSS Feed'],
    ['thanhnien.xml', 'Báo Thanh Niên'],
  ])('%s: 6 bài, tiêu đề/liên kết/ngày hợp lệ, tóm tắt đã bỏ thẻ HTML', (file, title) => {
    const f = parseFeed(feedFile(file), NOW);
    expect(f.kind).toBe('rss');
    expect(f.title).toBe(title.slice(0, 100));
    expect(f.items).toHaveLength(6);
    for (const it of f.items) {
      expect(it.title.length).toBeGreaterThan(5);
      expect(it.title.length).toBeLessThanOrEqual(300);
      expect(it.link).toMatch(/^https:\/\//);
      expect(it.guid.length).toBeGreaterThan(0);
      expect(it.summary).not.toMatch(/[<>]/);
      expect(it.summary.length).toBeLessThanOrEqual(2000);
      expect(it.published_at_ms).toBeGreaterThan(Date.parse('2026-10-01'));
      expect(it.published_at_ms).toBeLessThanOrEqual(NOW);
    }
    const stamps = f.items.map((i) => i.published_at_ms!);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps); // mới nhất trước
  });
  test('VnExpress: ảnh lấy từ <enclosure>; Tuổi Trẻ: ngày kiểu Mỹ "10/9/2026 10:05:00 PM" = 22:05 giờ VN', () => {
    expect(parseFeed(feedFile('vnexpress.xml'), NOW).items[0].image_url).toMatch(/^https:\/\/i1-vnexpress\.vnecdn\.net\//);
    const tt = parseFeed(feedFile('tuoitre.xml'), NOW);
    expect(tt.items.some((i) => i.published_at_ms === Date.parse('2026-10-09T15:05:00Z'))).toBe(true);
  });
  test('Thanh Niên: ngày 2 chữ số năm "Fri, 09 Oct 26 22:44:51 +0700" đọc đúng năm 2026', () => {
    expect(new Date(parseFeed(feedFile('thanhnien.xml'), NOW).items[0].published_at_ms!).getUTCFullYear()).toBe(2026);
  });
});

describe('Atom 1.0 · RSS 1.0 (RDF)', () => {
  const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog của Tùng</title>
  <entry><title type="html">Bài &lt;b&gt;một&lt;/b&gt;</title><id>tag:example.dev,2026:1</id>
    <link rel="self" href="https://example.dev/self"/><link rel="alternate" href="https://example.dev/bai-1"/>
    <updated>2026-10-08T10:00:00+07:00</updated><summary>Tóm tắt &amp; thực thể</summary></entry>
  <entry><title>Bài hai</title><id>tag:example.dev,2026:2</id><link href="https://example.dev/bai-2"/>
    <published>2026-10-09T01:00:00Z</published><content type="html">&lt;p&gt;Nội dung &lt;em&gt;dài&lt;/em&gt;&lt;/p&gt;&lt;img src="https://example.dev/a.jpg"&gt;</content></entry>
</feed>`;
  test('Atom: link rel=alternate, id làm guid, tiêu đề/tóm tắt bỏ thẻ, ảnh từ <img>', () => {
    const f = parseFeed(atom, NOW);
    expect(f.kind).toBe('atom');
    expect(f.title).toBe('Blog của Tùng');
    const [a, b] = f.items;
    expect(b).toMatchObject({ title: 'Bài một', guid: 'tag:example.dev,2026:1', link: 'https://example.dev/bai-1', summary: 'Tóm tắt & thực thể' });
    expect(a).toMatchObject({ title: 'Bài hai', link: 'https://example.dev/bai-2', summary: 'Nội dung dài', image_url: 'https://example.dev/a.jpg' });
  });
  const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel><title>Bản tin RDF</title></channel>
    <item><title>Tin 1</title><link>https://rdf.example/1</link><description>mô tả 1</description><dc:date>2026-10-07T00:00:00Z</dc:date></item></rdf:RDF>`;
  test('RDF: item nằm ngoài channel, dc:date', () => {
    const f = parseFeed(rdf, NOW);
    expect(f.kind).toBe('rdf');
    expect(f.title).toBe('Bản tin RDF');
    expect(f.items[0]).toMatchObject({ title: 'Tin 1', link: 'https://rdf.example/1', published_at_ms: Date.parse('2026-10-07T00:00:00Z') });
  });
});

describe('không phải feed → NotFeedError (INVALID_REQUEST)', () => {
  test.each([
    ['HTML', '<!doctype html><html><head><title>Trang chủ</title></head><body><p>xin chào</p></body></html>'],
    ['JSON', '{"items": []}'],
    ['rỗng', ''],
    ['XML khác', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['XML hỏng', '<rss><channel><title>x</title><item></channel>'],
    ['văn bản', 'không phải xml'],
    ['RSS thiếu channel', '<rss version="2.0"></rss>'],
  ])('%s', (_n, body) => {
    expect(() => parseFeed(body, NOW)).toThrow(NotFeedError);
  });
});

describe('ca biên bài', () => {
  const wrap = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`;
  test('BOM + khoảng trắng đầu (nld.com.vn) vẫn đọc được', () => {
    expect(parseFeed('﻿ \n ' + wrap('<item><title>A</title><link>https://a.vn/1</link></item>'), NOW).items).toHaveLength(1);
  });
  test('guid trùng trong cùng feed → một bài; thiếu guid → dùng link; guid là URL không có <link> → link', () => {
    const f = parseFeed(wrap('<item><title>A</title><link>https://a.vn/1</link><guid>g1</guid></item><item><title>A2</title><link>https://a.vn/2</link><guid>g1</guid></item><item><title>B</title><link>https://a.vn/b</link></item><item><title>C</title><guid>https://a.vn/c</guid></item>'), NOW);
    expect(f.items.map((i) => [i.title, i.guid, i.link])).toEqual([
      ['A', 'g1', 'https://a.vn/1'],
      ['B', 'https://a.vn/b', 'https://a.vn/b'],
      ['C', 'https://a.vn/c', 'https://a.vn/c'],
    ]);
  });
  test('bài không có địa chỉ mở được (không link, link javascript:/file:) bị bỏ', () => {
    const f = parseFeed(wrap('<item><title>X</title></item><item><title>Y</title><link>javascript:alert(1)</link></item><item><title>Z</title><link>file:///etc/passwd</link></item><item><title>OK</title><link>https://a.vn/ok</link></item>'), NOW);
    expect(f.items.map((i) => i.title)).toEqual(['OK']);
  });
  test('tiêu đề thiếu → "(Không có tiêu đề)"; tiêu đề/tóm tắt quá dài bị cắt đúng trần', () => {
    const f = parseFeed(wrap(`<item><link>https://a.vn/1</link></item><item><title>${'t'.repeat(400)}</title><link>https://a.vn/2</link><description>${'s'.repeat(3000)}</description></item>`), NOW);
    const byLink = Object.fromEntries(f.items.map((i) => [i.link, i]));
    expect(byLink['https://a.vn/1'].title).toBe('(Không có tiêu đề)');
    expect(byLink['https://a.vn/2'].title).toHaveLength(300);
    expect(byLink['https://a.vn/2'].summary).toHaveLength(2000);
  });
  test('mô tả CDATA có HTML, <br>, <script>: chỉ còn văn bản; &nbsp; không làm hỏng', () => {
    const f = parseFeed(wrap('<item><title>A</title><link>https://a.vn/1</link><description><![CDATA[<p>Dòng một</p><p>Dòng hai<br/>ba</p><script>alert(1)</script><style>p{}</style> &amp;nbsp; <b>đậm</b>]]></description></item>'), NOW);
    expect(f.items[0].summary).toBe('Dòng một Dòng hai ba &nbsp; đậm');
  });
  test('ảnh: chỉ http(s); ảnh javascript:/data: bỏ', () => {
    const f = parseFeed(wrap('<item><title>A</title><link>https://a.vn/1</link><enclosure url="javascript:x" type="image/png"/></item><item><title>B</title><link>https://a.vn/2</link><enclosure url="https://cdn.a.vn/i.jpg" type="image/jpeg"/></item><item><title>C</title><link>https://a.vn/3</link><description><![CDATA[<img src="data:image/png;base64,AAA">]]></description></item>'), NOW);
    const m = Object.fromEntries(f.items.map((i) => [i.title, i.image_url]));
    expect(m).toEqual({ A: null, B: 'https://cdn.a.vn/i.jpg', C: null });
  });
  test('tối đa 100 bài mỗi feed (giữ bài mới nhất)', () => {
    const many = Array.from({ length: 150 }, (_, i) => `<item><title>B${i}</title><link>https://a.vn/${i}</link><pubDate>${new Date(Date.parse('2026-10-01') + i * 60_000).toUTCString()}</pubDate></item>`).join('');
    const f = parseFeed(wrap(many), NOW);
    expect(f.items).toHaveLength(100);
    expect(f.items[0].title).toBe('B149');
  });
  test('stripHtml: thực thể, thẻ lạ, khoảng trắng', () => {
    expect(stripHtml('  a &lt;b&gt; &quot;c&quot; \n\n d  ')).toBe('a <b> "c" d');
    expect(stripHtml('<div>x</div><div>y</div>')).toBe('x y');
    expect(stripHtml('')).toBe('');
  });
});

describe('parseDate', () => {
  test('RFC 822, ISO, kiểu Mỹ; rác/quá cũ → null; tương lai xa → kéo về now', () => {
    expect(parseDate('Fri, 09 Oct 2026 11:36:30 +0700', NOW)).toBe(Date.parse('2026-10-09T04:36:30Z'));
    expect(parseDate('2026-10-08T10:00:00+07:00', NOW)).toBe(Date.parse('2026-10-08T03:00:00Z'));
    expect(parseDate('10/9/2026 12:05:00 AM', NOW)).toBe(Date.parse('2026-10-08T17:05:00Z'));
    expect(parseDate('10/9/2026 12:05:00 PM', NOW)).toBe(Date.parse('2026-10-09T05:05:00Z'));
    for (const bad of ['', 'hôm qua', '1970-01-01T00:00:00Z', '1999-12-31']) expect(parseDate(bad, NOW)).toBeNull();
    expect(parseDate('2099-01-01T00:00:00Z', NOW)).toBe(NOW);
  });
});

describe('itemId tất định', () => {
  const U = 'https://vnexpress.net/rss/tin-moi-nhat.rss';
  test('cùng (feed, guid) → cùng id UUID v4; khác guid/feed → khác id', () => {
    const a = itemId(U, 'g1');
    expect(a).toBe(itemId(U, 'g1'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(itemId(U, 'g2')).not.toBe(a);
    expect(itemId('https://khac.vn/rss', 'g1')).not.toBe(a);
  });
  test('thế hệ id kế tiếp (gen) khác id gốc nhưng cũng tất định', () => {
    const ids = [0, 1, 2].map((g) => itemId(U, 'g1', g));
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe(itemId(U, 'g1', 1));
  });
  test('1000 guid khác nhau không va chạm', () => {
    const set = new Set(Array.from({ length: 1000 }, (_, i) => itemId(U, `guid-${i}`)));
    expect(set.size).toBe(1000);
  });
});

describe('normalizeFeedUrl / safeHttpUrl', () => {
  test('thêm https:// khi thiếu scheme, bỏ #, host chữ thường, giữ cổng', () => {
    expect(normalizeFeedUrl('Blog.Example.dev/rss#x')).toMatchObject({ ok: true, url: 'https://blog.example.dev/rss', host: 'blog.example.dev' });
    expect(normalizeFeedUrl('  http://10.0.2.2:8787/feed.xml ')).toMatchObject({ ok: true, host: '10.0.2.2:8787' });
    expect(normalizeFeedUrl('https://a.vn:443/x')).toMatchObject({ ok: true, host: 'a.vn' }); // cổng mặc định bị chuẩn hoá bỏ
  });
  test.each(['', '   ', 'ftp://a.vn/x', 'javascript:alert(1)', 'https://u:p@a.vn/', 'https://a.vn/a b', 'file:///etc/passwd', 'https://', 'http://[::1]/x', `https://a.vn/${'x'.repeat(2100)}`])('từ chối %j', (raw) => {
    expect(normalizeFeedUrl(raw).ok).toBe(false);
  });
  test('safeHttpUrl', () => {
    expect(safeHttpUrl('https://a.vn/x?y=1')).toBe('https://a.vn/x?y=1');
    for (const bad of [null, undefined, '', 'javascript:1', 'ftp://a', 'https://u:p@a.vn', `https://a.vn/${'x'.repeat(2100)}`]) expect(safeHttpUrl(bad)).toBeNull();
  });
});

describe('time', () => {
  const at = (h: number, m = 0, d = 9) => new Date(2026, 9, d, h, m).getTime(); // 09/10/2026 giờ máy
  test('dayLabel / relTime', () => {
    const now = at(14, 0);
    expect(dayLabel(at(8), now)).toBe('Hôm nay');
    expect(dayLabel(at(23, 0, 8), now)).toBe('Hôm qua');
    expect(dayLabel(at(10, 0, 7), now)).toBe('Thứ Tư 07/10');
    expect(relTime(now - 30_000, now)).toBe('vừa xong');
    expect(relTime(now - 5 * 60_000, now)).toBe('5 phút trước');
    expect(relTime(at(11), now)).toBe('3 giờ trước');
    expect(relTime(at(21, 30, 8), now)).toBe('Hôm qua 21:30');
    expect(relTime(at(10, 0, 3), now)).toBe('03/10');
    expect(relTime(null, now)).toBe('');
  });
  test('quickTimes: chiều/tối chỉ hiện khi còn ≥ 5 phút; giờ treo đúng khuôn', () => {
    const noon = quickTimes(at(12, 0));
    expect(noon.map((q) => q.key)).toEqual(['hour', 'afternoon', 'evening', 'tomorrow']);
    expect(noon.find((q) => q.key === 'afternoon')!.at).toBe(wallTime(at(17)));
    expect(noon.find((q) => q.key === 'tomorrow')!.at).toBe(wallTime(at(7, 0, 10)));
    expect(quickTimes(at(16, 58)).map((q) => q.key)).toEqual(['hour', 'evening', 'tomorrow']);
    expect(quickTimes(at(21, 0)).map((q) => q.key)).toEqual(['hour', 'tomorrow']);
    for (const q of noon) expect(q.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
