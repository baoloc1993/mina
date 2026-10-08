import { APP_CSP, injectCsp } from './injectedSdk';

describe('AC-5: SDK và CSP có mặt trước script của app', () => {
  const app = '<html><head><title>x</title><script>APP_SCRIPT()</script></head><body></body></html>';

  test('SDK đứng trước script app trong <head>', () => {
    const out = injectCsp(app);
    expect(out.indexOf('window.miniapp')).toBeGreaterThan(-1);
    expect(out.indexOf('window.miniapp')).toBeLessThan(out.indexOf('APP_SCRIPT()'));
  });

  test('CSP connect-src none do shell chèn, đứng trước script app', () => {
    const out = injectCsp(app);
    expect(APP_CSP).toContain("connect-src 'none'");
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('APP_SCRIPT()'));
  });

  test('HTML không có <head> vẫn được chèn', () => {
    const out = injectCsp('<body><script>APP_SCRIPT()</script></body>');
    expect(out.indexOf('window.miniapp')).toBeLessThan(out.indexOf('APP_SCRIPT()'));
  });
});
