// SDK v0 inject vào WebView TRƯỚC khi script của app chạy (injectedJavaScriptBeforeContentLoaded).
// Mini app chỉ thấy window.miniapp; mọi thứ khác đi qua postMessage → bridge.
export const INJECTED_SDK = `
(function () {
  var pending = {};
  var seq = 0;
  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      window.ReactNativeWebView.postMessage(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }));
    });
  }
  window.__miniappResolve = function (raw) {
    var res = typeof raw === 'string' ? JSON.parse(raw) : raw;
    var p = pending[res.id];
    if (!p) return;
    delete pending[res.id];
    if (res.error) { var e = new Error(res.error.message); e.code = res.error.code; p.reject(e); }
    else p.resolve(res.result);
  };
  Object.defineProperty(window, 'miniapp', {
    value: Object.freeze({
      sdk: Object.freeze({ ready: function () { return call('sdk.ready'); } }),
      db: Object.freeze({
        query: function (sql, params) { return call('db.query', { sql: sql, params: params || [] }); },
        execute: function (sql, params) { return call('db.execute', { sql: sql, params: params || [] }); }
      }),
      auth: Object.freeze({ getAppToken: function () { return call('auth.getAppToken'); } }),
      // Gọi method tuỳ ý — chỉ để app thử ca phá (namespace không có scope sẽ bị SCOPE_DENIED).
      call: call
    }),
    writable: false,
    configurable: false
  });
  true;
})();
`;

/** CSP do shell chèn vào index.html của app — app không tự nới được. */
export const APP_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

export function injectCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  return `<head>${meta}</head>${html}`;
}
