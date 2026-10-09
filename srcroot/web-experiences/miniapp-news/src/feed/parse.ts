// Phân tích RSS 2.0 / Atom 1.0 / RSS 1.0 (RDF) bằng `DOMParser` của WebView — không thư viện feed (DECISIONS 2026-10-09).
// Thuần: nhận chuỗi XML, trả bài đã làm sạch. Không lưu toàn văn: tóm tắt = mô tả bỏ thẻ HTML, cắt 2 000 ký tự.
import { safeHttpUrl } from './url';

export const MAX_TITLE = 300;
export const MAX_SUMMARY = 2000;
export const MAX_GUID = 2048;
export const MAX_FEED_ITEMS = 100;

export interface ParsedItem {
  guid: string;
  title: string;
  summary: string;
  link: string;
  image_url: string | null;
  published_at_ms: number | null;
}
export interface ParsedFeed {
  kind: 'rss' | 'atom' | 'rdf';
  title: string;
  items: ParsedItem[];
}

/** Không phải RSS/Atom (HTML, JSON, XML khác, hỏng). */
export class NotFeedError extends Error {
  readonly code = 'INVALID_REQUEST';
}

const MIN_DATE = 946_684_800_000; // 2000-01-01
const ONE_DAY = 86_400_000;

const nameOf = (el: Element) => (el.localName || el.nodeName.replace(/^.*:/, '')).toLowerCase();
const kids = (el: Element, name: string): Element[] => Array.from(el.children).filter((c) => nameOf(c) === name);
const kid = (el: Element, ...names: string[]): Element | null => {
  for (const n of names) {
    const k = kids(el, n)[0];
    if (k) return k;
  }
  return null;
};
const textOf = (el: Element | null): string => (el?.textContent ?? '').trim();

/** HTML → văn bản thuần: bỏ thẻ, giải mã thực thể, gom khoảng trắng. */
export function stripHtml(input: string): string {
  const s = input ?? '';
  if (!/[<&]/.test(s)) return s.replace(/\s+/g, ' ').trim();
  const spaced = s.replace(/<\/?(br|p|div|li|tr|h[1-6]|blockquote)\b[^>]*>/gi, ' ').replace(/<\/br\s*>/gi, ' ');
  const doc = new DOMParser().parseFromString(`<body>${spaced}</body>`, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  return (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Ảnh đầu tiên trong đoạn HTML mô tả (`<img src>`), chỉ http(s). */
function firstImg(html: string): string | null {
  const m = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i.exec(html);
  return m ? safeHttpUrl(m[1].replace(/&amp;/g, '&')) : null;
}

const IMG_EXT = /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i;

function imageOf(item: Element, descriptionHtml: string): string | null {
  for (const enc of kids(item, 'enclosure')) {
    const url = enc.getAttribute('url');
    const type = (enc.getAttribute('type') ?? '').toLowerCase();
    if (url && (type.startsWith('image/') || (!type && IMG_EXT.test(url)))) return safeHttpUrl(url);
  }
  for (const n of ['content', 'thumbnail']) {
    for (const m of kids(item, n)) {
      const url = m.getAttribute('url');
      const type = (m.getAttribute('type') ?? m.getAttribute('medium') ?? '').toLowerCase();
      if (url && (nameOf(m) === 'thumbnail' || !type || type.startsWith('image'))) {
        const u = safeHttpUrl(url);
        if (u) return u;
      }
    }
  }
  for (const l of kids(item, 'link')) {
    if ((l.getAttribute('rel') ?? '') === 'enclosure' && (l.getAttribute('type') ?? '').startsWith('image/')) {
      const u = safeHttpUrl(l.getAttribute('href'));
      if (u) return u;
    }
  }
  return firstImg(descriptionHtml);
}

/**
 * Ngày xuất bản → epoch ms. RFC 822 / ISO 8601 qua `Date.parse`; riêng Tuổi Trẻ dùng "M/D/YYYY h:mm:ss AM" (kiểu Mỹ, giờ Việt Nam GMT+7).
 * Ngoài [2000, nay + 1 ngày] → ngày tương lai bị kéo về `now` (không ghim bài lên đầu mãi), năm quá cũ / hỏng → null.
 */
export function parseDate(raw: string, now: number): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let ms = NaN;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(s);
  if (us) {
    let h = Number(us[4]) % 12;
    if (us[7].toUpperCase() === 'PM') h += 12;
    ms = Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]), h, Number(us[5]), Number(us[6] ?? 0)) - 7 * 3_600_000;
  } else ms = Date.parse(s.replace(/GMT\+7$/i, '+0700'));
  if (!Number.isFinite(ms) || ms < MIN_DATE) return null;
  return ms > now + ONE_DAY ? now : ms;
}

function atomLink(entry: Element): string {
  const links = kids(entry, 'link');
  const alt = links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate' && l.getAttribute('href'));
  return (alt ?? links.find((l) => l.getAttribute('href') && !l.getAttribute('rel')))?.getAttribute('href')?.trim() ?? '';
}

function buildItem(kind: ParsedFeed['kind'], el: Element, now: number): ParsedItem | null {
  const atom = kind === 'atom';
  const rawLink = atom ? atomLink(el) : textOf(kid(el, 'link'));
  const guidEl = kid(el, atom ? 'id' : 'guid');
  const guidRaw = textOf(guidEl);
  // Không có <link> nhưng <guid isPermaLink> là URL → dùng làm link.
  const link = safeHttpUrl(rawLink) ?? (guidEl && guidEl.getAttribute('isPermaLink') !== 'false' ? safeHttpUrl(guidRaw) : null);
  if (!link) return null; // không có địa chỉ mở được thì bài vô dụng
  const descEl = kid(el, 'description', 'summary', 'encoded', 'content');
  const descHtml = descEl?.textContent ?? '';
  const title = stripHtml(textOf(kid(el, 'title'))).slice(0, MAX_TITLE) || '(Không có tiêu đề)';
  const dateEl = kid(el, 'pubdate', 'published', 'date', 'updated');
  return {
    guid: (guidRaw || rawLink.trim() || link).slice(0, MAX_GUID),
    title,
    summary: stripHtml(descHtml).slice(0, MAX_SUMMARY),
    link,
    image_url: imageOf(el, descHtml),
    published_at_ms: parseDate(textOf(dateEl), now),
  };
}

/** Phân tích văn bản feed. Ném `NotFeedError` khi không phải RSS/Atom/RDF. */
export function parseFeed(text: string, now = Date.now()): ParsedFeed {
  const src = (text ?? '').replace(/^﻿/, '').trim();
  if (!src || src[0] !== '<') throw new NotFeedError('Không phải RSS/Atom');
  const doc = new DOMParser().parseFromString(src, 'application/xml');
  const root = doc.documentElement;
  if (!root || doc.getElementsByTagName('parsererror').length || nameOf(root) === 'parsererror') throw new NotFeedError('Không phải RSS/Atom');
  const rootName = nameOf(root);
  let kind: ParsedFeed['kind'];
  let container: Element;
  let entries: Element[];
  if (rootName === 'rss') {
    const ch = kid(root, 'channel');
    if (!ch) throw new NotFeedError('RSS thiếu <channel>');
    kind = 'rss';
    container = ch;
    entries = kids(ch, 'item');
  } else if (rootName === 'feed') {
    kind = 'atom';
    container = root;
    entries = kids(root, 'entry');
  } else if (rootName === 'rdf') {
    kind = 'rdf';
    container = kid(root, 'channel') ?? root;
    entries = kids(root, 'item');
  } else throw new NotFeedError('Không phải RSS/Atom');

  const seen = new Set<string>();
  const items: ParsedItem[] = [];
  for (const e of entries) {
    const it = buildItem(kind, e, now);
    if (!it || seen.has(it.guid)) continue;
    seen.add(it.guid);
    items.push(it);
  }
  // Mới nhất trước (feed thường đã sắp sẵn; bài không có ngày giữ vị trí tương đối), cắt trần.
  const ranked = items.map((it, i) => ({ it, i })).sort((a, b) => (b.it.published_at_ms ?? 0) - (a.it.published_at_ms ?? 0) || a.i - b.i);
  const title = stripHtml(textOf(kid(container, 'title'))).slice(0, 100);
  return { kind, title, items: ranked.slice(0, MAX_FEED_ITEMS).map((r) => r.it) };
}
