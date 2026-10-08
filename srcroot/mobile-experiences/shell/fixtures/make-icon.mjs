// Sinh icon.png 256×256 cho fixture: chữ cái trắng (--color-on-primary) trên nền --color-primary, bằng zlib thuần Node.
// Dùng: node fixtures/make-icon.mjs <chữ> <đường-dẫn-ra.png> [màu-nền-hex]
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(readFileSync(join(here, '../packages/miniapp-sdk/tokens/tokens.json'), 'utf8'));

// Font 5×7 cho vài chữ cái cần dùng (mỗi hàng là 5 bit).
const FONT = {
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export function makeIconPng(letter, bg = tokens.color.primary, fg = tokens.color['on-primary']) {
  const W = 256;
  const glyph = FONT[letter.toUpperCase()] ?? FONT.H;
  const cell = 28; // 5×28 = 140 rộng, 7×28 = 196 cao
  const x0 = Math.floor((W - 5 * cell) / 2);
  const y0 = Math.floor((W - 7 * cell) / 2);
  const [br, bgc, bb] = hex(bg);
  const [fr, fgc, fb] = hex(fg);
  const raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) {
    raw[y * (W * 3 + 1)] = 0; // filter None
    for (let x = 0; x < W; x++) {
      const gx = Math.floor((x - x0) / cell);
      const gy = Math.floor((y - y0) / cell);
      const on = gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && glyph[gy][gx] === '1';
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = on ? fr : br;
      raw[o + 1] = on ? fgc : bgc;
      raw[o + 2] = on ? fb : bb;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(W, 4);
  ihdr[8] = 8; // 8 bit
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [letter, out, bg] = process.argv.slice(2);
  if (!letter || !out) {
    console.error('Dùng: node fixtures/make-icon.mjs <chữ> <ra.png> [#nền]');
    process.exit(1);
  }
  writeFileSync(out, makeIconPng(letter, bg));
  console.log('đã ghi', out);
}
