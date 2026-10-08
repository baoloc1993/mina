// Mock SDK trên trình duyệt (CAP-RT-07, AC-9, màn S10): chạy mini app trong iframe sandbox trên INJECTED_SDK thật,
// mọi RPC đi qua `handleRpc` THẬT của shell (shell/src/bridge) với Host trình duyệt (SQLite WASM, fetch qua dev server…).
import '../../tokens/tokens.css';
import './styles.css';
import { handleRpc, KNOWN_SCOPES, METHOD_TABLE, type BridgeContext, type Manifest, type RpcRequest, type RpcResponse } from '../../../../src/bridge/bridge';
import { CASES, summarizeMatrix } from '../../../../src/bridge/matrix';
import { EXPECTED_SUMMARY } from '../../../../src/bridge/matrix.expected';
import { injectCsp } from '../../src/csp';
import { createTabBus } from './bus';
import { inferTablePrefix, prepareDatabase, type Migration } from './db';
import { createMockHost, type HopFetch, type NetMode } from './host';
import { openWasmDb } from './sqliteWasm';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Script chạy trong iframe TRƯỚC SDK: nối __miniappTransport/Resolve/Event với trang cha qua postMessage.
const PRE_SCRIPT = `(function(){
  window.__miniappTransport = function (s) { parent.postMessage({ __mina: 1, t: 'rpc', raw: s }, '*'); };
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== parent || !d || d.__mina !== 1) return;
    if (d.t === 'rpc-res') window.__miniappResolve(d.raw);
    else if (d.t === 'event') window.__miniappEvent(d.name, d.payload);
  });
})();`;

interface FixtureData {
  manifest: Manifest;
  html: string;
  migrations: Migration[];
}

// ---------- log (C16) ----------
interface LogRow {
  time: string;
  method: string;
  scope: string;
  state: 'wait' | 'ok' | 'bad';
  text: string;
  key?: string;
  count?: number;
  sub?: string;
}
const rows: LogRow[] = [];
const logEl = $('log');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const short = (v: unknown, n = 90) => {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s && s.length > n ? s.slice(0, n - 1) + '…' : (s ?? '');
};
function renderLog() {
  logEl.innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<div><span class="wait">${r.time}</span><span>${esc(r.method)}${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}</span><span class="wait">${esc(r.scope)}</span><span class="${r.state}">${esc(r.text)}${r.count && r.count > 1 ? ` ×${r.count}` : ''}</span></div>`,
        )
        .join('')
    : '<div class="empty"><span>Chưa có lời gọi nào — bấm nút trong app mẫu</span></div>';
}
function addRow(r: Omit<LogRow, 'time'>): LogRow {
  const row: LogRow = { time: new Date().toLocaleTimeString('vi-VN'), ...r };
  rows.unshift(row);
  if (rows.length > 300) rows.pop();
  renderLog();
  return row;
}
$('clear').onclick = () => {
  rows.length = 0;
  renderLog();
};

// ---------- toast (C10) ----------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, openLabel?: () => void) {
  $('toast-text').textContent = text;
  const btn = $<HTMLButtonElement>('toast-open');
  btn.hidden = !openLabel;
  btn.onclick = () => {
    openLabel?.();
    $('toast').classList.remove('show');
  };
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4000);
}

// ---------- helpers ----------
const scopeLabel = (method: string) => {
  const d = METHOD_TABLE.find((m) => m.method === method);
  if (!d) return 'không có trong SDK v0';
  return d.scopes.length ? d.scopes.join(' + ') : '—';
};
const b64 = (buf: ArrayBuffer) => {
  let s = '';
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

const hopFetch: HopFetch = async (req) => {
  const r = await fetch('/__mock/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
};

function pickImages(multiple: boolean): Promise<{ name: string; mime: string; base64: string }[]> {
  return new Promise((ok) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.onchange = async () => {
      const out = [];
      for (const f of Array.from(input.files ?? [])) out.push({ name: f.name, mime: f.type || 'image/png', base64: b64(await f.arrayBuffer()) });
      ok(out);
    };
    input.addEventListener('cancel', () => ok([]));
    input.click();
  });
}

// ---------- khởi động ----------
async function main() {
  const list = await (await fetch('/__mock/fixtures')).json();
  const params = new URLSearchParams(location.search);
  const name: string | null = params.get('fixture') ?? list.default;
  const sel = $<HTMLSelectElement>('fixture');
  sel.innerHTML = list.fixtures.map((f: { name: string; id: string; version: string }) => `<option value="${esc(f.name)}">${esc(f.name)} · ${esc(f.version)}</option>`).join('');
  if (!name) {
    $('title').textContent = 'Mock SDK · không có fixture';
    logEl.innerHTML = '<div class="empty"><span>Không thấy fixture nào — chạy: npm run mock -- fixtures/miniapp-hello</span></div>';
    return;
  }
  sel.value = name;
  sel.onchange = () => {
    location.search = `?fixture=${encodeURIComponent(sel.value)}`;
  };
  $('open-tab').onclick = () => window.open(`?fixture=${encodeURIComponent(sel.value)}`, '_blank');

  const fx: FixtureData = await (await fetch(`/__mock/fixture/${encodeURIComponent(name)}`)).json();
  let manifest: Manifest = { ...fx.manifest, scopes: [...fx.manifest.scopes] };
  const tablePrefix = params.get('prefix') ?? inferTablePrefix(manifest, fx.migrations);
  $('title').textContent = `Mock SDK · ${name}`;
  document.title = `Mock SDK · ${manifest.name}`;
  $('splash-icon').textContent = manifest.name.slice(0, 1).toUpperCase();
  $('manifest-info').textContent = `${manifest.id} ${manifest.version} · tiền tố bảng ${tablePrefix}_ · tables: ${manifest.tables.join(', ')} · network: ${(manifest.network ?? []).join(', ') || '—'}`;

  // ----- DB -----
  // Một DB dùng chung cho mọi fixture/tab (như SQLite của shell: core_* thấy chung); ảnh chụp lưu IndexedDB.
  const db = await openWasmDb('shared');
  const prep = prepareDatabase(db, manifest, tablePrefix, fx.migrations);
  db.persist();
  addRow({
    method: 'mock: nạp DB',
    scope: '—',
    state: prep.warnings.length ? 'bad' : 'ok',
    text: db.restored ? 'khôi phục DB đã lưu' : 'DB mới',
    sub: `migration áp: ${prep.applied.join(', ') || '—'}; bỏ qua: ${prep.skipped.join(', ') || '—'}${prep.addedColumns.length ? `; thêm cột hệ thống: ${prep.addedColumns.length}` : ''}${prep.warnings.length ? `; ${prep.warnings.join(' ')}` : ''}`,
  });
  $('reset-db').onclick = async () => {
    await db.wipe();
    location.reload();
  };

  // ----- host + bus + ctx -----
  const frame = $<HTMLIFrameElement>('app');
  const post = (m: Record<string, unknown>) => frame.contentWindow?.postMessage({ __mina: 1, ...m }, '*');
  const sendEvent = (name: string, payload: unknown) => post({ t: 'event', name, payload: JSON.stringify(payload ?? null) });
  let netMode: NetMode = 'online';
  let iframeLoaded = false;

  const bus = createTabBus(() => manifest);
  db.onSaved = () => bus.notifyDb();
  bus.onDb(() => void db.reload());
  bus.announce(manifest);
  const mock = createMockHost({
    manifest: () => manifest,
    driver: db,
    hopFetch,
    bus,
    netMode: () => netMode,
    callbacks: {
      onReady: () => $('splash').classList.add('hide'),
      onSuspended: () => addRow({ method: 'app → shell: suspended', scope: '—', state: 'ok', text: 'đã lưu xong' }),
      onToast: (t) => toast(t),
      onDbWrite: () => db.persist(),
      onNotify: (n, phase) => {
        addRow({
          method: `notify ${phase}`,
          scope: 'notify.local',
          state: 'ok',
          text: phase === 'fired' ? 'thông báo kêu' : phase === 'scheduled' ? `đặt lúc ${new Date(n.at).toLocaleTimeString('vi-VN')}` : 'đã huỷ',
          sub: n.title,
        });
        if (phase === 'fired') toast(`Thông báo: ${n.title}`);
      },
      pickImage: ({ multiple }) => pickImages(multiple),
      share: async (s) => {
        if (navigator.share) {
          try {
            await navigator.share({ title: s.title, text: s.text, url: s.url ?? undefined });
          } catch {
            /* huỷ share sheet không phải lỗi */
          }
        } else toast(`Chia sẻ (giả lập): ${s.title || s.text || s.url}`);
      },
    },
  });
  const ctx: BridgeContext = {
    get manifest() {
      return manifest;
    },
    tablePrefix,
    host: mock.host,
  };

  // intent đến tab này → chuyển cho iframe
  bus.onIntent((m) => {
    if (!iframeLoaded) return false;
    sendEvent('intent', { type: m.type, version: m.version, payload: m.payload, ref: null, mode: m.mode });
    addRow({ method: `intent ← ${m.from}`, scope: 'intents.receives', state: 'ok', text: m.mode === 'open' ? 'opened' : 'handled', sub: `${m.type}@${m.version} ${short(m.payload, 70)}` });
    toast(m.mode === 'open' ? `Mở ${manifest.name}: ${m.type}` : `Đã nhận ${m.type} · Mở?`, m.mode === 'create' ? () => window.focus() : undefined);
    return true;
  });

  // ----- RPC từ iframe -----
  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (e.source !== frame.contentWindow || !d || d.__mina !== 1 || d.t !== 'rpc') return;
    let req: RpcRequest;
    try {
      req = JSON.parse(d.raw);
    } catch {
      addRow({ method: '(JSON hỏng)', scope: '—', state: 'bad', text: 'INVALID_REQUEST' });
      return;
    }
    const row = addRow({ method: String(req?.method), scope: scopeLabel(String(req?.method)), state: 'wait', text: 'đang chờ…', sub: short(req?.params) });
    const resp: RpcResponse = await handleRpc(req, ctx);
    if (resp.error) {
      row.state = 'bad';
      row.text = resp.error.code;
      row.sub = `${short(req?.params, 60)} → ${resp.error.message}${resp.error.detail ? ` (${resp.error.detail})` : ''}`;
    } else {
      row.state = 'ok';
      row.text = 'OK';
      row.sub = `${short(req?.params, 50)} → ${short(resp.result, 60)}`;
    }
    // Lời gọi lặp y hệt đã OK (app thăm dò định kỳ) gộp vào một dòng ×N để log không bị ngập.
    if (!resp.error) {
      const key = `${req.method}|${JSON.stringify(req.params)}|${JSON.stringify(resp.result)}`;
      const prev = rows.findIndex((x, i) => x !== row && i < 40 && x.state === 'ok' && x.key === key);
      if (prev >= 0) {
        const keep = rows[prev];
        keep.count = (keep.count ?? 1) + 1;
        keep.time = row.time;
        rows.splice(rows.indexOf(keep), 1);
        rows.splice(rows.indexOf(row), 1);
        rows.unshift(keep);
      } else row.key = key;
    }
    renderLog();
    post({ t: 'rpc-res', raw: JSON.stringify(resp) });
  });

  // ----- iframe -----
  const loadApp = () => {
    iframeLoaded = false;
    $('splash').classList.remove('hide');
    frame.onload = () => {
      iframeLoaded = true;
    };
    frame.srcdoc = injectCsp(fx.html, PRE_SCRIPT);
  };
  loadApp();

  // ----- thanh điều khiển -----
  const netSel = $<HTMLSelectElement>('net');
  netSel.onchange = () => {
    netMode = netSel.value as NetMode;
    mock.resetPending();
    const st = mock.host.sync.status();
    sendEvent('sync', st);
    addRow({ method: 'app ← sync', scope: '—', state: 'ok', text: `${st.state}${netMode === 'ro' ? ' · chỉ đọc' : ''}`, sub: short(st) });
  };
  $('ev-suspend').onclick = () => {
    addRow({ method: 'app ← suspend', scope: '—', state: 'ok', text: 'đã gửi' });
    sendEvent('suspend', null);
  };
  $('ev-resume').onclick = () => {
    addRow({ method: 'app ← resume', scope: '—', state: 'ok', text: 'đã gửi' });
    sendEvent('resume', null);
  };
  $('ev-reload').onclick = () => {
    addRow({ method: 'WebView huỷ + nạp lại', scope: '—', state: 'ok', text: 'app tự khôi phục từ DB' });
    loadApp();
  };

  // scope
  const scopesEl = $('scopes');
  const refreshSummary = () => {
    $('scopes-summary').textContent = `Manifest · scope (${manifest.scopes.length}/${KNOWN_SCOPES.length}) — bỏ chọn để thấy SCOPE_DENIED`;
  };
  scopesEl.innerHTML = KNOWN_SCOPES.map((s) => `<label><input type="checkbox" data-scope="${s}" ${manifest.scopes.includes(s) ? 'checked' : ''}> ${s}</label>`).join('');
  scopesEl.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const s = input.dataset.scope!;
    const next = new Set(manifest.scopes);
    if (input.checked) next.add(s);
    else next.delete(s);
    manifest = { ...manifest, scopes: [...next] };
    bus.announce(manifest);
    refreshSummary();
    addRow({ method: `manifest.scopes ${input.checked ? '+' : '−'} ${s}`, scope: '—', state: 'ok', text: 'đã đổi' });
  });
  refreshSummary();

  // ma trận scope
  $('matrix').onclick = async () => {
    const got = await summarizeMatrix();
    const mismatches: string[] = [];
    const exp = new Map(EXPECTED_SUMMARY.map((l) => l.split('|') as [string, string, string, string]).map((p) => [p[0], p] as const));
    const ns = new Map(CASES.map((c) => [c.method, c.namespace]));
    let table = '<table class="matrix"><caption>Ma trận scope — chạy handleRpc thật với Host giả có bộ đếm</caption><thead><tr><th>namespace</th><th>method</th><th>không có scope</th><th>có scope</th><th>chỉ đọc</th></tr></thead><tbody>';
    for (const line of got) {
      const p = line.split('|');
      const want = exp.get(p[0]);
      const cells = [1, 2, 3].map((i) => {
        const ok = want?.[i] === p[i];
        if (!ok) mismatches.push(`${p[0]} cột ${i}: nhận ${p[i]}, mong ${want?.[i] ?? '(thiếu dòng)'}`);
        return `<td class="${ok ? (p[i] === 'OK' ? 'ok' : 'bad') : 'bad'}">${esc(p[i])}${ok ? '' : ` ≠ ${esc(want?.[i] ?? '?')}`}</td>`;
      });
      table += `<tr><td class="ns">${ns.get(p[0]) ?? ''}</td><td>${esc(p[0])}</td>${cells.join('')}</tr>`;
    }
    table += '</tbody></table>';
    for (const k of exp.keys()) if (!got.some((l) => l.startsWith(`${k}|`))) mismatches.push(`thiếu dòng ${k} trong kết quả`);
    const pass = !mismatches.length && got.length === EXPECTED_SUMMARY.length;
    const namespaces = new Set(CASES.map((c) => c.namespace)).size;
    $('matrix-out').innerHTML = `<div class="verdict ${pass ? 'ok' : 'bad'}">${pass ? `PASS — ${got.length} method · ${namespaces} namespace khớp bảng kỳ vọng (matrix.expected.ts)` : `FAIL — ${mismatches.length} ô lệch`}</div>${table}`;
    addRow({ method: 'ma trận scope', scope: `${namespaces} namespace × (không scope / có scope / chỉ đọc)`, state: pass ? 'ok' : 'bad', text: pass ? 'PASS' : 'FAIL', sub: pass ? `${got.length} dòng khớp bảng kỳ vọng` : mismatches.slice(0, 3).join('; ') });
  };

  // Cho trình kiểm tự động: bấm hộ ma trận bằng ?matrix=1
  if (params.get('matrix') === '1') $('matrix').click();
}

renderLog();
main().catch((e) => {
  addRow({ method: 'mock: lỗi khởi động', scope: '—', state: 'bad', text: 'INTERNAL', sub: String(e?.stack ?? e) });
});
