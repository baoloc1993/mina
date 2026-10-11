// CSP + chèn SDK vào index.html của mini app — dùng chung cho mock SDK và (đề xuất) shell.
// Bản gốc của vòng 1 nằm ở shell/src/webview/injectedSdk.ts (APP_CSP, injectCsp); bản này giữ NGUYÊN chuỗi APP_CSP và
// chèn INJECTED_SDK v0 mới. Khi shell chuyển sang SDK 0.1.0, nên import từ đây để không có hai bản.
import { INJECTED_SDK } from './injected';

/** CSP do shell chèn vào index.html của app — app không tự nới được. */
export const APP_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * Chèn CSP + (script tiền đề tuỳ chọn) + SDK vào <head> TRƯỚC mọi script của app.
 * `preScript` chạy ngay trước SDK (mock dùng nó để định nghĩa `__miniappTransport`).
 */
export function injectCsp(html: string, preScript = ''): string {
  const pre = preScript ? `<script>${preScript}</script>` : '';
  const meta = `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">${pre}<script>${INJECTED_SDK}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  return `<head>${meta}</head>${html}`;
}
