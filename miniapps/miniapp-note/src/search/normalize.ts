// Chuẩn hoá để tìm không dấu (AC-5): chữ thường → NFD bỏ dấu kết hợp → `đ→d` → gom khoảng trắng.
// Cùng một hàm cho nội dung (ghi vào `notes.search_text`) và từ khoá — nên "ghi chu" khớp "Ghi chú", "dang ky" khớp "Đăng ký".
export function normalize(s: string): string {
  return s
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chuẩn hoá MỘT ký tự (giữ khoảng trắng; dấu kết hợp rời → rỗng) — dùng để ánh xạ vị trí chuẩn hoá về văn bản gốc. */
function normChar(c: string): string {
  return c === ' ' ? ' ' : normalize(c);
}

/** Tách từ khoá đã chuẩn hoá; bỏ từ rỗng và trùng. */
export function searchTerms(q: string): string[] {
  return [...new Set(normalize(q).split(' ').filter(Boolean))].slice(0, 8);
}

/** Mẫu `LIKE '%…%' ESCAPE '\'` — escape `\`, `%`, `_` trong từ khoá. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

/** Trích đoạn hiển thị ở danh sách: đoạn đầu của nội dung, gom khoảng trắng, không chuẩn hoá (giữ dấu). */
export function makeSnippet(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function mapNormalized(text: string): { out: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    for (const ch of normChar(text[i])) {
      out += ch;
      map.push(i);
    }
  }
  return { out, map };
}

/**
 * Đoạn trích quanh chỗ khớp đầu tiên, GIỮ dấu của văn bản gốc (khác `search_text` đã bỏ dấu). Chuẩn hoá từng ký tự để
 * chỉ số chuẩn hoá ánh xạ ngược được về vị trí gốc. Không khớp → đầu văn bản.
 */
export function excerptAround(text: string, terms: string[], radius = 60): string {
  const flat = text.replace(/\s+/g, ' ');
  if (!terms.length) return makeSnippet(flat, radius * 2);
  const { out, map } = mapNormalized(flat);
  let at = -1;
  for (const t of terms) {
    const p = out.indexOf(t);
    if (p >= 0 && (at < 0 || p < at)) at = p;
  }
  if (at < 0) return makeSnippet(flat, radius * 2);
  const from = Math.max(0, map[at] - radius);
  const to = Math.min(flat.length, map[at] + radius);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to).trim()}${to < flat.length ? '…' : ''}`;
}

/** Từng đoạn của `text` kèm cờ "khớp" (để tô đậm/gạch chân). Dùng cùng ánh xạ chuẩn hoá. */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[] {
  if (!terms.length || !text) return [{ text, hit: false }];
  const { out, map } = mapNormalized(text);
  const mark = new Array<boolean>(text.length).fill(false);
  for (const t of terms) {
    let from = 0;
    for (;;) {
      const p = out.indexOf(t, from);
      if (p < 0) break;
      for (let j = p; j < p + t.length; j++) mark[map[j]] = true;
      from = p + t.length;
    }
  }
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === mark[i]) last.text += text[i];
    else parts.push({ text: text[i], hit: mark[i] });
  }
  return parts;
}
