// TỰ SINH từ tokens/tokens.json bằng scripts/build-tokens.mjs — đừng sửa tay.
export const tokens = {
  "color": {
    "bg": "#FFFFFF",
    "surface": "#F2F4F7",
    "text": "#111318",
    "text-muted": "#5B6472",
    "primary": "#0A5BD3",
    "on-primary": "#FFFFFF",
    "border": "#6F7886",
    "danger": "#C62828",
    "success": "#1B7A3E",
    "warning": "#8A5200",
    "overlay": "#111318"
  },
  "font": {
    "sans": "system-ui, -apple-system, Roboto, \"Segoe UI\", sans-serif"
  },
  "text": {
    "sm": "15px",
    "base": "17px",
    "lg": "20px",
    "xl": "28px"
  },
  "space": {
    "xs": "4px",
    "sm": "8px",
    "md": "16px",
    "lg": "24px",
    "xl": "40px"
  },
  "radius": {
    "md": "12px",
    "lg": "20px"
  },
  "shadow": "0 2px 8px rgba(17,19,24,.08)",
  "tapMin": "48px",
  "iconApp": "64px"
} as const;

export type Tokens = typeof tokens;
/** Tên biến CSS → giá trị, đúng như tokens.css. */
export const cssVars = {
  "--color-bg": "#FFFFFF",
  "--color-surface": "#F2F4F7",
  "--color-text": "#111318",
  "--color-text-muted": "#5B6472",
  "--color-primary": "#0A5BD3",
  "--color-on-primary": "#FFFFFF",
  "--color-border": "#6F7886",
  "--color-danger": "#C62828",
  "--color-success": "#1B7A3E",
  "--color-warning": "#8A5200",
  "--color-overlay": "#111318",
  "--font-sans": "system-ui, -apple-system, Roboto, \"Segoe UI\", sans-serif",
  "--text-sm": "15px",
  "--text-base": "17px",
  "--text-lg": "20px",
  "--text-xl": "28px",
  "--space-xs": "4px",
  "--space-sm": "8px",
  "--space-md": "16px",
  "--space-lg": "24px",
  "--space-xl": "40px",
  "--radius-md": "12px",
  "--radius-lg": "20px",
  "--shadow": "0 2px 8px rgba(17,19,24,.08)",
  "--tap-min": "48px",
  "--icon-app": "64px"
} as const;
