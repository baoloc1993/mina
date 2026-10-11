// Sinh SQL dữ liệu mẫu Đọc báo cho dogfood đợt 2 (PRD §7 "Dữ liệu mẫu"): tenant-a có 4 nguồn (2 gợi ý + 1 dán URL có grant + 1 feed giả lỗi),
// ~60 bài (10 đã đọc, 6 đọc sau — 2 của nguồn đã bỏ, 3 quá 30 ngày chưa lưu, 1 đã lưu thành note) và 1 grant.
// Dùng:  node scripts/seed-news.mjs <tenant_id> > news.sql   (rồi psql < news.sql). Chạy lại an toàn (ON CONFLICT DO NOTHING).
import { createHash } from 'node:crypto';

const tenant = process.argv[2];
if (!tenant || !/^[0-9a-f-]{36}$/.test(tenant)) {
  console.error('Dùng: node scripts/seed-news.mjs <tenant_id uuid>');
  process.exit(1);
}
const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();
const uuidFor = (name) => {
  const h = createHash('sha1').update(`${tenant}:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const q = (s) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const num = (n) => (n === null || n === undefined ? 'null' : String(n));
const out = [];

const sources = [
  { key: 'vnexpress', name: 'VnExpress', url: 'https://vnexpress.net/rss/tin-moi-nhat.rss', host: 'vnexpress.net', suggested: 'vnexpress', err: null },
  { key: 'tuoitre', name: 'Tuổi Trẻ', url: 'https://tuoitre.vn/home.rss', host: 'tuoitre.vn', suggested: 'tuoitre', err: null },
  { key: 'blog', name: 'Blog thử (máy chủ giả)', url: 'http://10.0.2.2:8787/ok.xml', host: '10.0.2.2:8787', suggested: null, err: null },
  { key: 'loi', name: 'Feed lỗi', url: 'http://10.0.2.2:8787/503', host: '10.0.2.2:8787', suggested: null, err: 'NET_ERROR|Trang trả về 503' },
  { key: 'bo', name: 'KhoaHoc.tv', url: 'https://khoahoc.tv/rss/home.rss', host: 'khoahoc.tv', suggested: null, err: null, removed: true },
];
sources.forEach((s, i) => {
  s.id = uuidFor(`source:${s.key}`);
  out.push(
    `insert into app_vn_app_news_sources (id, tenant_id, name, feed_url, host, position, suggested_key, last_fetched_at_ms, last_error, deleted_at) values (` +
      `${q(s.id)}, ${q(tenant)}, ${q(s.name)}, ${q(s.url)}, ${q(s.host)}, ${i}, ${q(s.suggested)}, ${num(now - 30 * 60_000)}, ${q(s.err)}, ${s.removed ? 'now()' : 'null'}) on conflict (id) do nothing;`,
  );
});

const titles = [
  'Giá vàng trong nước đi ngang', 'Hà Nội đón không khí lạnh đầu mùa', 'Đội tuyển Việt Nam chốt danh sách tập trung', 'Giá xăng giảm nhẹ từ chiều nay',
  'Khai trương tuyến buýt điện mới', 'Học sinh Hà Nội thi học kỳ sớm', 'Công nghệ AI vào lớp học', 'Mùa lúa chín ở Tây Bắc',
  'Triển lãm ảnh về Hà Nội xưa', 'Cà phê muối trở lại', 'Tắc đường ở cửa ngõ phía Nam', 'Ra mắt điện thoại gập giá mềm',
];
let n = 0;
const item = (src, ageH, over = {}) => {
  n += 1;
  const t = titles[n % titles.length];
  const fetched = now - ageH * HOUR;
  const row = {
    id: uuidFor(`item:${src.key}:${n}`), title: `${t} (${src.name} #${n})`, summary: `Tóm tắt bài ${n}: ${t}. Nội dung mẫu để thử cuộn danh sách, cắt dòng và đọc offline.`,
    link: `http://10.0.2.2:8787/bai/${n}`, published: fetched - HOUR, fetched, read: null, saved: null, note: null, ...over,
  };
  out.push(
    `insert into app_vn_app_news_items (id, tenant_id, source_id, guid, title, summary, link, image_url, published_at_ms, fetched_at_ms, read_at_ms, saved_at_ms, note_id, updated_at) values (` +
      `${q(row.id)}, ${q(tenant)}, ${q(src.id)}, ${q(`g-${src.key}-${n}`)}, ${q(row.title)}, ${q(row.summary)}, ${q(row.link)}, null, ${num(row.published)}, ${num(row.fetched)}, ${num(row.read)}, ${num(row.saved)}, ${q(row.note)}, ` +
      `${over.serverOld ? `now() - interval '40 days'` : 'now()'}) on conflict (id) do nothing;`,
  );
  return row;
};

const live = sources.filter((s) => !s.removed);
for (let i = 0; i < 44; i++) {
  const src = live[i % live.length];
  const over = {};
  if (i < 10) over.read = now - (i + 1) * HOUR; // 10 đã đọc
  item(src, i * 2 + 1, over);
}
// đọc sau: 4 của nguồn còn + 2 của nguồn đã bỏ; 1 trong số đó đã lưu thành note
const saved = [];
saved.push(item(live[0], 20, { saved: now - 3 * HOUR }));
saved.push(item(live[1], 30, { saved: now - 5 * HOUR }));
saved.push(item(live[2], 40, { saved: now - 8 * HOUR, note: uuidFor('note:1') }));
saved.push(item(live[0], 50, { saved: now - DAY }));
const bo = sources.find((s) => s.removed);
item(bo, 60, { saved: now - 2 * DAY });
item(bo, 70, { saved: now - 3 * DAY });
// quá 30 ngày chưa lưu (app dọn khi mở; server job nếu updated_at cũng quá 30 ngày)
item(live[0], 31 * 24 + 2, { serverOld: true });
item(live[1], 33 * 24, { serverOld: true });
item(live[1], 40 * 24, { serverOld: true });

// grant của host fake (đã cho phép sẵn) — bảng sync core_net_grants
out.push(
  `insert into core_net_grants (id, tenant_id, app_id, host) values (${q(uuidFor('grant:10.0.2.2:8787'))}, ${q(tenant)}, 'vn.app.news', '10.0.2.2:8787') on conflict (id) do nothing;`,
);
console.error(`${live.length} nguồn + 1 nguồn đã bỏ, ${n} bài, 1 grant`);
console.log(out.join('\n'));
