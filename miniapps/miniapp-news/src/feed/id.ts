// Id bài TẤT ĐỊNH: hai máy tải cùng một bài ra cùng một `id` ⇒ `upload` gộp thay vì nhân đôi.
// Hash 128 bit thuần JS (cyrb128) của `tenant_id|feed_url|guid` ép khuôn UUID v4 — không dùng crypto.randomUUID (không tất định).

function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');

/**
 * `gen` > 0 dùng khi id gốc đã bị xoá mềm (nguồn bỏ rồi thêm lại): một dòng đã xoá không hồi sinh được, nên bài đó lấy id kế tiếp
 * `hash(feed_url|guid|#gen)` — hai máy cùng đi qua cùng dãy nên vẫn hội tụ cùng id.
 */
export function itemId(tenantId: string, feedUrl: string, guid: string, gen = 0): string {
  const [a, b, c, d] = cyrb128(`${tenantId}|${feedUrl}|${guid}${gen > 0 ? `|#${gen}` : ''}`);
  const h = hex8(a) + hex8(b) + hex8(c) + hex8(d);
  const variant = (parseInt(h.slice(16, 17), 16) & 0x3 | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const ID_GENERATIONS = 3;
