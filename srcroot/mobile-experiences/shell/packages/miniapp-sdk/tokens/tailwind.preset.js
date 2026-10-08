// TỰ SINH từ tokens/tokens.json bằng scripts/build-tokens.mjs — đừng sửa tay.
/** @type {Partial<import("tailwindcss").Config>} */
module.exports = {
  "theme": {
    "extend": {
      "colors": {
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
      "fontFamily": {
        "sans": [
          "system-ui",
          "-apple-system",
          "Roboto",
          "\"Segoe UI\"",
          "sans-serif"
        ]
      },
      "fontSize": {
        "sm": "15px",
        "base": "17px",
        "lg": "20px",
        "xl": "28px"
      },
      "spacing": {
        "xs": "4px",
        "sm": "8px",
        "md": "16px",
        "lg": "24px",
        "xl": "40px",
        "tap-min": "48px",
        "icon-app": "64px"
      },
      "borderRadius": {
        "md": "12px",
        "lg": "20px"
      },
      "boxShadow": {
        "DEFAULT": "0 2px 8px rgba(17,19,24,.08)"
      },
      "minHeight": {
        "tap-min": "48px"
      }
    }
  }
};
