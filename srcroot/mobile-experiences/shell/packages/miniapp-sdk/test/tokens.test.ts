import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { cssVars, tokens } from '../tokens/tokens';

const root = join(__dirname, '..');
const json = JSON.parse(readFileSync(join(root, 'tokens/tokens.json'), 'utf8'));
const css = readFileSync(join(root, 'tokens/tokens.css'), 'utf8');
const preset = createRequire(__filename)('../tokens/tailwind.preset.js');

describe('tokens khớp DESIGN-SYSTEM.md §2', () => {
  test('tokens.ts khớp tokens.json', () => {
    const { $comment, ...rest } = json;
    expect($comment).toBeTruthy();
    expect(JSON.parse(JSON.stringify(tokens))).toEqual(rest);
  });

  test('tokens.css có đúng từng biến, đúng giá trị', () => {
    const declared = [...css.matchAll(/^\s*(--[\w-]+):\s*(.+);$/gm)].map((m) => [m[1], m[2]]);
    expect(Object.fromEntries(declared)).toEqual(cssVars);
    expect(declared).toHaveLength(11 + 1 + 4 + 5 + 2 + 1 + 2);
    expect(css).toContain('--color-primary: #0A5BD3;');
    expect(css).toContain('--text-base: 17px;');
    expect(css).toContain('--tap-min: 48px;');
  });

  test('tailwind preset đặt tên theo token', () => {
    const t = preset.theme.extend;
    expect(t.colors['text-muted']).toBe('#5B6472');
    expect(t.colors.primary).toBe('#0A5BD3');
    expect(t.fontSize.base).toBe('17px');
    expect(t.spacing.md).toBe('16px');
    expect(t.spacing['tap-min']).toBe('48px');
    expect(t.borderRadius.lg).toBe('20px');
    expect(t.boxShadow.DEFAULT).toBe(json.shadow);
    expect(Object.keys(t.colors)).toEqual(Object.keys(json.color));
  });

  test('build:tokens chạy lại không đổi file nào (idempotent)', () => {
    const files = ['tokens.css', 'tailwind.preset.js', 'tokens.ts'];
    const read = () => files.map((f) => readFileSync(join(root, 'tokens', f), 'utf8'));
    const before = read();
    execFileSync(process.execPath, [join(root, 'scripts/build-tokens.mjs')]);
    expect(read()).toEqual(before);
  });
});

function lum(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

// 15 cặp ở DESIGN-SYSTEM.md §3: [chữ/viền, nền, ngưỡng] — chữ thường ≥ 4.5, thành phần ≥ 3.
const PAIRS: [string, string, number][] = [
  ['text', 'bg', 4.5],
  ['text-muted', 'bg', 4.5],
  ['text', 'surface', 4.5],
  ['text-muted', 'surface', 4.5],
  ['on-primary', 'primary', 4.5],
  ['primary', 'bg', 4.5],
  ['primary', 'surface', 4.5],
  ['danger', 'bg', 4.5],
  ['danger', 'surface', 4.5],
  ['success', 'surface', 4.5],
  ['warning', 'surface', 4.5],
  ['on-primary', 'danger', 4.5],
  ['border', 'bg', 3],
  ['border', 'surface', 3],
  ['primary', 'bg', 3],
];

describe('tương phản WCAG AA (DESIGN-SYSTEM.md §3)', () => {
  test('đủ 15 cặp', () => expect(PAIRS).toHaveLength(15));
  test.each(PAIRS)('%s trên %s ≥ %s', (fg, bg, min) => {
    const ratio = contrast(json.color[fg], json.color[bg]);
    expect(ratio, `${fg}/${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
  });
});
