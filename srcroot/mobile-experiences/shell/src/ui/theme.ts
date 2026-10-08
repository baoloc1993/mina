// Token design system → style React Native. NGUỒN màu/chữ/nhịp duy nhất: packages/miniapp-sdk/tokens (DESIGN-SYSTEM.md §2).
// Không file UI nào được viết mã màu / cỡ chữ / khoảng cách thô: chỉ import từ đây.
import type { TextStyle, ViewStyle } from 'react-native';
import { tokens } from '../../packages/miniapp-sdk/tokens/tokens';

const px = (s: string): number => parseFloat(s);

export const color = tokens.color;
export type ColorToken = keyof typeof tokens.color;

export const fontSize = {
  sm: px(tokens.text.sm),
  base: px(tokens.text.base),
  lg: px(tokens.text.lg),
  xl: px(tokens.text.xl),
} as const;
export type FontSizeToken = keyof typeof fontSize;

export const space = {
  xs: px(tokens.space.xs),
  sm: px(tokens.space.sm),
  md: px(tokens.space.md),
  lg: px(tokens.space.lg),
  xl: px(tokens.space.xl),
} as const;

export const radius = { md: px(tokens.radius.md), lg: px(tokens.radius.lg) } as const;
export const tapMin = px(tokens.tapMin);
export const iconApp = px(tokens.iconApp);

/** Trọng lượng chữ: tiêu đề 700, nhãn 600, còn lại 400 (DESIGN-SYSTEM §2.2). */
export const weight = { title: '700', label: '600', regular: '400' } as const;

/** Dòng cao theo cỡ chữ (không phải token — suy từ cỡ chữ để chữ tiếng Việt có dấu không bị cắt). */
export const lineHeight = (size: number): number => Math.round(size * 1.35);

/** Hằng số hình thức không nằm trong bảng token nhưng suy từ token / quy ước DS. */
export const stroke = { thin: 1, focus: 2, accent: 4 } as const;
export const opacity = { disabled: 0.4, overlay: 0.45, faint: 0.5, dim: 0.4, pressed: 0.8 } as const;
export const glyphBig = space.xl + space.md; // 56 — icon lớn của khuôn rỗng / lỗi
export const iconCard = glyphBig; // 56 — icon trong thẻ catalog
export const chipHeight = space.xl - space.sm; // 32
export const dotSize = space.sm + 2; // chấm trạng thái ~10
export const badgeSize = space.md + space.xs; // 20 — vòng "!" / "i" trong banner
export const dragScale = 1.05;
export const monoFamily = 'monospace';

/** Chuỗi bóng token (`0 2px 8px rgba(...)`) → số cho shadow của RN. Màu bóng = `overlay` với độ đục lấy từ token. */
export function parseShadow(s: string): { offsetY: number; blur: number; alpha: number } {
  const m = /(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px\s+rgba\([^)]*?,\s*(\d*\.?\d+)\s*\)/.exec(s);
  if (!m) return { offsetY: 2, blur: 8, alpha: 0.08 };
  return { offsetY: Number(m[2]), blur: Number(m[3]), alpha: Number(m[4]) };
}
const sh = parseShadow(tokens.shadow);
export const shadow: ViewStyle = {
  shadowColor: color.overlay,
  shadowOffset: { width: 0, height: sh.offsetY },
  shadowOpacity: sh.alpha,
  shadowRadius: sh.blur,
  elevation: sh.offsetY,
};

export const type: Record<FontSizeToken, TextStyle> = {
  sm: { fontSize: fontSize.sm, lineHeight: lineHeight(fontSize.sm) },
  base: { fontSize: fontSize.base, lineHeight: lineHeight(fontSize.base) },
  lg: { fontSize: fontSize.lg, lineHeight: lineHeight(fontSize.lg) },
  xl: { fontSize: fontSize.xl, lineHeight: lineHeight(fontSize.xl) },
};

/** Số cột và nhịp của lưới launcher (DESIGN-SYSTEM §2.4: 4 cột). */
export const launcherColumns = 4;
export const launcherRowHeight = iconApp + space.xs + lineHeight(fontSize.sm) * 2 + space.md;
