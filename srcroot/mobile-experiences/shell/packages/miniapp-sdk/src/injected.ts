// SDK v0 (@platform/miniapp-sdk 0.1.0) — chuỗi JS ES5 được chèn vào <head> của mini app TRƯỚC script của app.
// Dùng chung cho shell (WebView Android) và mock SDK (iframe trên trình duyệt) — một nguồn, hai nơi chạy.
// Quy tắc viết chuỗi này: KHÔNG dùng dấu huyền, "${", hay dấu gạch chéo ngược (template literal của TS sẽ diễn giải chúng).
//
// Vận chuyển: JSON-RPC 2.0. Gửi bằng window.__miniappTransport(chuỗiJSON) nếu có (mock), không thì
// window.ReactNativeWebView.postMessage(chuỗiJSON) (shell). Nhận phản hồi: shell/mock gọi window.__miniappResolve(raw).
// Sự kiện shell → app: window.__miniappEvent(tên, payload) với tên suspend | resume | intent | sync.
export const INJECTED_SDK = `
(function () {
  if (window.miniapp) return; // đã được chèn (vào HTML hoặc qua WebView) — không định nghĩa lại
  var SUSPEND_HANDLER_MS = 450;
  var MAX_QUEUED_INTENTS = 20;
  var EVENTS = ['suspend', 'resume', 'intent', 'sync'];
  var pending = {};
  var seq = 0;
  var handlers = { suspend: [], resume: [], intent: [], sync: [] };
  var queuedIntents = [];

  function fail(code, message) { var e = new Error(message); e.code = code; return e; }

  function transport(json) {
    if (typeof window.__miniappTransport === 'function') window.__miniappTransport(json);
    else if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') window.ReactNativeWebView.postMessage(json);
    else throw fail('INTERNAL', 'Không có đường nối tới shell');
  }

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        transport(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params === undefined ? {} : params }));
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  }

  function parse(raw) {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  function resolveRpc(raw) {
    var res = parse(raw);
    if (!res || typeof res !== 'object') return;
    var p = pending[res.id];
    if (!p) return;
    delete pending[res.id];
    if (res.error) {
      var e = new Error(res.error.message);
      e.code = res.error.code;
      if (res.error.detail !== undefined) e.detail = res.error.detail;
      p.reject(e);
    } else p.resolve(res.result);
  }

  function safe(fn, arg) {
    try { return fn(arg); } catch (e) { return undefined; }
  }

  function runSuspend(payload) {
    var list = handlers.suspend.slice();
    var jobs = list.map(function (h) {
      return new Promise(function (resolve) {
        var timer = setTimeout(resolve, SUSPEND_HANDLER_MS);
        var done = function () { clearTimeout(timer); resolve(); };
        try { Promise.resolve(h(payload)).then(done, done); } catch (e) { done(); }
      });
    });
    Promise.all(jobs).then(function () { return call('sdk.suspended'); }).then(null, function () {});
  }

  function onEvent(name, payload) {
    var data = parse(payload);
    if (name === 'lifecycle.suspend') name = 'suspend';
    if (name === 'lifecycle.resume') name = 'resume';
    if (name === 'suspend') return runSuspend(data);
    if (name === 'intent' && !handlers.intent.length) {
      queuedIntents.push(data);
      if (queuedIntents.length > MAX_QUEUED_INTENTS) queuedIntents.shift();
      return;
    }
    if (handlers[name]) handlers[name].slice().forEach(function (h) { safe(h, data); });
  }

  function on(event, fn) {
    if (EVENTS.indexOf(event) < 0) throw fail('INVALID_REQUEST', 'Sự kiện không hỗ trợ: ' + event);
    if (typeof fn !== 'function') throw fail('INVALID_REQUEST', 'Handler phải là hàm');
    handlers[event].push(fn);
    if (event === 'intent' && queuedIntents.length) {
      var q = queuedIntents.splice(0, queuedIntents.length);
      Promise.resolve().then(function () { q.forEach(function (i) { safe(fn, i); }); });
    }
    return function () {
      var k = handlers[event].indexOf(fn);
      if (k >= 0) handlers[event].splice(k, 1);
    };
  }

  function epoch(at) {
    if (Object.prototype.toString.call(at) === '[object Date]') return at.getTime();
    if (typeof at === 'string') return Date.parse(at);
    return at;
  }

  function stmts(list) {
    if (!Array.isArray(list)) return list;
    return list.map(function (s) {
      return s && typeof s === 'object' ? { sql: s.sql, params: s.params || [] } : s;
    });
  }

  function o(x) { return x && typeof x === 'object' ? x : {}; }

  var api = Object.freeze({
    sdk: Object.freeze({
      ready: function () { return call('sdk.ready'); },
      info: function () { return call('sdk.info'); },
      on: on
    }),
    db: Object.freeze({
      query: function (sql, params, opts) { return call('db.query', { sql: sql, params: params || [], includeDeleted: !!o(opts).includeDeleted }); },
      execute: function (sql, params) { return call('db.execute', { sql: sql, params: params || [] }); },
      transaction: function (list) { return call('db.transaction', { statements: stmts(list) }); }
    }),
    core: Object.freeze({
      tags: Object.freeze({
        list: function () { return call('core.tags.list'); },
        create: function (t) { return call('core.tags.create', { name: o(t).name, color: o(t).color }); }
      }),
      contacts: Object.freeze({
        search: function (q) { return call('core.contacts.search', { q: q }); },
        create: function (c) { return call('core.contacts.create', { name: o(c).name, phone: o(c).phone, email: o(c).email, note: o(c).note }); }
      }),
      files: Object.freeze({
        get: function (id) { return call('core.files.get', { id: id }); },
        list: function (opts) { return call('core.files.list', { appId: o(opts).appId }); }
      })
    }),
    intent: Object.freeze({
      send: function (type, payload, opts) {
        return call('intent.send', { type: type, payload: payload, mode: o(opts).mode || 'create', version: o(opts).version });
      }
    }),
    notify: Object.freeze({
      schedule: function (n) {
        var x = o(n);
        var ref = x.ref;
        if (ref !== undefined && ref !== null && typeof ref !== 'string') ref = JSON.stringify(ref);
        return call('notify.schedule', { id: x.id, at: epoch(x.at), title: x.title, body: x.body, ref: ref });
      },
      cancel: function (id) { return call('notify.cancel', { id: id }); },
      list: function () { return call('notify.list'); }
    }),
    storage: Object.freeze({
      put: function (f) { return call('storage.put', { name: o(f).name, mime: o(f).mime, base64: o(f).base64 }); },
      get: function (fileId) { return call('storage.get', { fileId: fileId }); },
      remove: function (fileId) { return call('storage.remove', { fileId: fileId }); }
    }),
    net: Object.freeze({
      fetch: function (url, opts) {
        var x = o(opts);
        return call('net.fetch', { url: url, method: x.method, headers: x.headers, body: x.body, timeoutMs: x.timeoutMs });
      }
    }),
    ui: Object.freeze({
      toast: function (text) { return call('ui.toast', { text: text }); },
      pickImage: function (opts) { return call('ui.pickImage', { multiple: !!o(opts).multiple }); },
      share: function (s) { return call('ui.share', { title: o(s).title, text: o(s).text, url: o(s).url }); }
    }),
    sync: Object.freeze({ status: function () { return call('sync.status'); } }),
    auth: Object.freeze({ getAppToken: function () { return call('auth.getAppToken'); } }),
    // Gọi method tuỳ ý — chỉ để app thử ca phá (method/namespace không có scope sẽ bị SCOPE_DENIED).
    call: call
  });

  Object.defineProperty(window, '__miniappResolve', { value: resolveRpc, writable: false, configurable: false });
  Object.defineProperty(window, '__miniappEvent', { value: onEvent, writable: false, configurable: false });
  Object.defineProperty(window, 'miniapp', { value: api, writable: false, configurable: false });
  true;
})();
`;
