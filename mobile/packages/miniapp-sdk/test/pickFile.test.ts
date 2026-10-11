// SDK 0.1.1 — `ui.pickFile` trên mock SDK dưới handleRpc THẬT của shell: lọc MIME, giới hạn 50 MB, không để file mồ côi.
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { handleRpc, matchesMime, type BridgeContext, type Manifest, type RpcResponse } from '../../../src/bridge/bridge';
import { createTabBus, type TabBus } from '../mock/src/bus';
import { inferTablePrefix, prepareDatabase } from '../mock/src/db';
import { createMockHost } from '../mock/src/host';
import { loadFixture } from '../mock/plugin';
import { openNodeDb } from './nodeDriver';

const FIX = join(__dirname, '../../../fixtures');
const buses: TabBus[] = [];
afterEach(() => {
  while (buses.length) buses.pop()!.close();
});

type Picked = { name: string; mime: string; base64: string }[];
function rig(picked: Picked, scopes?: string[]) {
  const fx = loadFixture(join(FIX, 'miniapp-hello-cal')); // khai ui.native + storage.files
  const manifest: Manifest = { ...fx.manifest, scopes: scopes ?? fx.manifest.scopes };
  const prefix = inferTablePrefix(manifest, fx.migrations);
  const db = openNodeDb();
  prepareDatabase(db, manifest, prefix, fx.migrations);
  const bus = createTabBus(() => manifest, `pf-${Date.now()}-${Math.random()}`);
  buses.push(bus);
  let asked: { mime: string[]; multiple: boolean } | null = null;
  const mock = createMockHost({
    manifest: () => manifest,
    driver: db,
    hopFetch: async () => ({ status: 200, headers: {}, body: '' }),
    bus,
    netMode: () => 'online',
    callbacks: { pickFile: async (o) => ((asked = o), picked) },
  });
  const ctx: BridgeContext = { manifest, tablePrefix: prefix, host: mock.host };
  return {
    call: (params: Record<string, unknown>): Promise<RpcResponse> => handleRpc({ jsonrpc: '2.0', id: 1, method: 'ui.pickFile', params }, ctx),
    db,
    asked: () => asked,
  };
}
const files = (r: ReturnType<typeof rig>) => r.db.all('SELECT COUNT(*) AS n FROM core_files', [])[0].n as number;
const b64 = (n: number) => Buffer.alloc(n, 1).toString('base64');

describe('matchesMime', () => {
  test('danh sách rỗng nhận mọi loại; image/* khớp theo họ; không phân biệt hoa thường', () => {
    expect(matchesMime([], 'application/zip')).toBe(true);
    expect(matchesMime(['application/pdf'], 'application/pdf')).toBe(true);
    expect(matchesMime(['application/pdf'], 'Application/PDF')).toBe(true);
    expect(matchesMime(['application/pdf'], 'application/msword')).toBe(false);
    expect(matchesMime(['image/*'], 'image/png')).toBe(true);
    expect(matchesMime(['image/*'], 'text/plain')).toBe(false);
    expect(matchesMime(['image/*'], 'imagefoo/x')).toBe(false);
  });
});

describe('ui.pickFile (SDK 0.1.1)', () => {
  test('chọn PDF hợp lệ → fileId + uri + name + size, file vào core_files; bộ lọc tới tay host', async () => {
    const r = rig([{ name: 'hop.pdf', mime: 'application/pdf', base64: b64(300) }]);
    const res = await r.call({ mime: ['application/pdf'] });
    expect(res.error).toBeUndefined();
    const out = res.result as { files: { fileId: string; name: string; size: number; mime: string }[] };
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatchObject({ name: 'hop.pdf', mime: 'application/pdf', size: 300 });
    expect(r.asked()).toEqual({ mime: ['application/pdf'], multiple: false });
    expect(files(r)).toBe(1);
  });

  test('tệp sai loại → INVALID_REQUEST, KHÔNG lưu gì (kể cả tệp đúng loại đi cùng)', async () => {
    const r = rig([{ name: 'a.pdf', mime: 'application/pdf', base64: b64(10) }, { name: 'b.docx', mime: 'application/vnd.openxmlformats', base64: b64(10) }]);
    const res = await r.call({ mime: ['application/pdf'], multiple: true });
    expect(res.error?.code).toBe('INVALID_REQUEST');
    expect(files(r)).toBe(0);
  });

  test('tệp > 50 MB → INVALID_REQUEST, không lưu', async () => {
    const r = rig([{ name: 'to.pdf', mime: 'application/pdf', base64: b64(51 * 1024 * 1024) }]);
    const res = await r.call({ mime: ['application/pdf'] });
    expect(res.error?.code).toBe('INVALID_REQUEST');
    expect(files(r)).toBe(0);
  });

  test('huỷ chọn → { files: [] }', async () => {
    const r = rig([]);
    const res = await r.call({});
    expect(res.result).toEqual({ files: [] });
  });

  test('tham số hỏng → INVALID_REQUEST trước khi mở hộp chọn', async () => {
    const r = rig([]);
    expect((await r.call({ mime: 'application/pdf' })).error?.code).toBe('INVALID_REQUEST');
    expect((await r.call({ mime: ['<script>'] })).error?.code).toBe('INVALID_REQUEST');
    expect((await r.call({ mime: Array(11).fill('image/png') })).error?.code).toBe('INVALID_REQUEST');
    expect(r.asked()).toBeNull();
  });

  test('thiếu scope storage.files hoặc ui.native → SCOPE_DENIED, không mở hộp chọn', async () => {
    const a = rig([], ['ui.native']);
    expect((await a.call({})).error?.code).toBe('SCOPE_DENIED');
    const b = rig([], ['storage.files']);
    expect((await b.call({})).error?.code).toBe('SCOPE_DENIED');
    expect(a.asked()).toBeNull();
    expect(b.asked()).toBeNull();
  });
});
