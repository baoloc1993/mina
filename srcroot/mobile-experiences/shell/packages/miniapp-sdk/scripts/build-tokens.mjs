// Sinh tokens.css, tailwind.preset.js, tokens.ts từ tokens/tokens.json (nguồn: DESIGN-SYSTEM.md §2).
// Chạy: npm run build:tokens (ở thư mục shell). Idempotent — chạy lại cho ra đúng cùng byte.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'tokens');
const t = JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8'));

/** Danh sách phẳng [tênBiếnCSS, giáTrị] theo thứ tự bảng §2. */
export function flatten(tokens) {
  const out = [];
  for (const k of Object.keys(tokens.color)) out.push([`color-${k}`, tokens.color[k]]);
  out.push(['font-sans', tokens.font.sans]);
  for (const k of Object.keys(tokens.text)) out.push([`text-${k}`, tokens.text[k]]);
  for (const k of Object.keys(tokens.space)) out.push([`space-${k}`, tokens.space[k]]);
  for (const k of Object.keys(tokens.radius)) out.push([`radius-${k}`, tokens.radius[k]]);
  out.push(['shadow', tokens.shadow]);
  out.push(['tap-min', tokens.tapMin]);
  out.push(['icon-app', tokens.iconApp]);
  return out;
}

const HEADER = '// TỰ SINH từ tokens/tokens.json bằng scripts/build-tokens.mjs — đừng sửa tay.\n';

const css =
  '/* TỰ SINH từ tokens/tokens.json bằng scripts/build-tokens.mjs — đừng sửa tay. Nguồn: DESIGN-SYSTEM.md §2. */\n:root {\n' +
  flatten(t).map(([k, v]) => `  --${k}: ${v};`).join('\n') +
  '\n}\n';
writeFileSync(join(dir, 'tokens.css'), css);

const preset = {
  theme: {
    extend: {
      colors: { ...t.color },
      fontFamily: { sans: t.font.sans.split(',').map((s) => s.trim()) },
      fontSize: { ...t.text },
      spacing: { ...t.space, 'tap-min': t.tapMin, 'icon-app': t.iconApp },
      borderRadius: { ...t.radius },
      boxShadow: { DEFAULT: t.shadow },
      minHeight: { 'tap-min': t.tapMin },
    },
  },
};
writeFileSync(
  join(dir, 'tailwind.preset.js'),
  HEADER + '/** @type {Partial<import("tailwindcss").Config>} */\nmodule.exports = ' + JSON.stringify(preset, null, 2) + ';\n',
);

const ts =
  HEADER +
  `export const tokens = ${JSON.stringify(t, null, 2).replace(/^\{\n {2}"\$comment".*\n/, '{\n')} as const;\n\n` +
  'export type Tokens = typeof tokens;\n' +
  '/** Tên biến CSS → giá trị, đúng như tokens.css. */\n' +
  `export const cssVars = ${JSON.stringify(Object.fromEntries(flatten(t).map(([k, v]) => [`--${k}`, v])), null, 2)} as const;\n`;
writeFileSync(join(dir, 'tokens.ts'), ts);
console.log('đã sinh tokens.css, tailwind.preset.js, tokens.ts');
