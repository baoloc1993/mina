// AC-15: bảng kỳ vọng namespace × (có / không scope / chỉ đọc). Cùng file matrix.ts chạy ở Vitest của mock SDK (AC-9).
import { CASES, makeFakeHost, manifestWith, runCase, summarizeMatrix } from './matrix';
import { handleRpc, METHOD_TABLE } from './bridge';

describe('AC-15 scope guard — mọi namespace SDK v0', () => {
  test('bảng phủ đủ 10 namespace và mọi method của bridge', () => {
    const ns = new Set(CASES.map((c) => c.namespace));
    expect([...ns].sort()).toEqual(['auth', 'core', 'db', 'intent', 'net', 'notify', 'storage', 'sync', 'sdk', 'ui'].sort());
    const covered = new Set(CASES.map((c) => c.method));
    // sdk.suspended, core.files.get, storage… có test riêng; ở đây chỉ buộc bảng không bỏ sót method nào ngoài danh sách đã biết
    const extra = METHOD_TABLE.map((m) => m.method).filter((m) => !covered.has(m));
    expect(extra.sort()).toEqual(['core.files.get', 'sdk.suspended'].sort());
  });

  test.each(CASES.filter((c) => c.grants.length))('$method: thiếu scope → SCOPE_DENIED, 0 lời gọi Host', async (c) => {
    const r = await runCase(c, []);
    expect(r.resp.error?.code).toBe('SCOPE_DENIED');
    expect(r.total).toBe(0);
  });

  test.each(CASES.filter((c) => c.grants.length > 1))('$method: thiếu MỘT trong các scope → SCOPE_DENIED', async (c) => {
    for (const drop of c.grants) {
      const r = await runCase(c, c.grants.filter((g) => g !== drop));
      expect(r.resp.error?.code).toBe('SCOPE_DENIED');
      expect(r.total).toBe(0);
    }
  });

  test.each(CASES)('$method: có scope → chạy', async (c) => {
    const r = await runCase(c, c.grants);
    expect(r.resp.error).toBeUndefined();
    if (c.effect) expect(r.calls[c.effect]).toBeGreaterThan(0);
  });

  test.each(CASES.filter((c) => c.writes))('$method: chỉ đọc → READ_ONLY, 0 lời gọi Host', async (c) => {
    const r = await runCase(c, c.grants, { readOnly: true });
    expect(r.resp.error?.code).toBe('READ_ONLY');
    expect(r.total).toBe(0);
  });

  test.each(CASES.filter((c) => !c.writes))('$method: chỉ đọc vẫn chạy với method không ghi', async (c) => {
    const r = await runCase(c, c.grants, { readOnly: true });
    expect(r.resp.error).toBeUndefined();
  });

  test('scope db cũ (vòng 1) là bí danh của db.own', async () => {
    const c = CASES.find((x) => x.method === 'db.query')!;
    const r = await runCase(c, ['db']);
    expect(r.resp.error).toBeUndefined();
  });

  test(':write gồm :read', async () => {
    const c = CASES.find((x) => x.method === 'core.tags.list')!;
    const r = await runCase(c, ['core.tags:write']);
    expect(r.resp.error).toBeUndefined();
  });

  test('method lạ → SCOPE_DENIED, không chạm Host', async () => {
    const f = makeFakeHost();
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'fs.readFile' }, { manifest: manifestWith(['db.own']), tablePrefix: 'app_hello', host: f.host });
    expect(r.error?.code).toBe('SCOPE_DENIED');
    expect(f.total()).toBe(0);
  });

  test('bảng tóm tắt ổn định (so với mock SDK)', async () => {
    const s = await summarizeMatrix();
    expect(s).toContain('db.execute|SCOPE_DENIED|OK|READ_ONLY');
    expect(s).toContain('sync.status|OK|OK|OK');
    expect(s).toContain('intent.send|SCOPE_DENIED|OK|READ_ONLY');
  });
});
