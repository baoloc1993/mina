import { popRoute, pushRoute, type Route } from './nav';
import { planLine, readOnlyBannerText, rejectionBannerText, rejectionTitle } from './text';
import { cardState } from '../ui/cardState';
import type { CatalogItem } from '../runtime/types';

const base = { id: 'a', name: 'A', local: null, action: 'install', uninstalledWithData: false } as unknown as CatalogItem;
const item = (p: Partial<CatalogItem>): CatalogItem => ({ ...base, ...p }) as CatalogItem;

describe('nav', () => {
  it('push/pop theo stack, ở gốc thì pop trả null (hệ thống xử lý BACK)', () => {
    const s0: Route[] = [{ name: 'launcher' }];
    const s1 = pushRoute(s0, { name: 'catalog' });
    const s2 = pushRoute(s1, { name: 'detail', appId: 'x' });
    expect(s2.map((r) => r.name)).toEqual(['launcher', 'catalog', 'detail']);
    expect(popRoute(s2)?.map((r) => r.name)).toEqual(['launcher', 'catalog']);
    expect(popRoute(s0)).toBeNull();
  });
  it('không chồng hai route cùng loại ở đỉnh, nhưng detail khác app thì chồng', () => {
    const s = pushRoute([{ name: 'launcher' }, { name: 'sync' }], { name: 'sync' });
    expect(s).toHaveLength(2);
    const d1 = pushRoute([{ name: 'detail', appId: 'a' }], { name: 'detail', appId: 'a' });
    expect(d1).toHaveLength(1);
    const d2 = pushRoute([{ name: 'detail', appId: 'a' }], { name: 'detail', appId: 'b' });
    expect(d2).toHaveLength(2);
  });
});

describe('text', () => {
  it('planLine', () => {
    expect(planLine({ plan: 'mvp-unlimited', max_apps: null, until: null })).toBe('Không giới hạn app');
    expect(planLine({ plan: 'free', max_apps: 2, until: null })).toBe('Tối đa 2 app');
    expect(planLine(null)).toContain('Chưa xác minh');
  });
  it('readOnlyBannerText, rejectionTitle', () => {
    expect(readOnlyBannerText('grace-over')).toContain('Chỉ đọc');
    expect(readOnlyBannerText('clock-rolled-back')).toContain('đồng hồ');
    const r = { id: '1', source: 'server', app: 'x', table: 'app_hello_items', op: 'PATCH', code: 'FORBIDDEN', detail: null, data: null, createdAt: '' } as const;
    expect(rejectionTitle(r, 'Hello')).toBe('Hello · app_hello_items · PATCH');
    expect(rejectionTitle({ ...r, table: null, op: null }, 'Hello')).toBe('Hello');
    expect(rejectionTitle({ ...r, source: 'local' }, 'Hello', '0.3.0')).toBe('Hello · cập nhật 0.3.0');
    expect(rejectionBannerText(1, [{ ...r, source: 'local' }])).toBe('1 app không cập nhật được');
    expect(rejectionBannerText(2, [r])).toBe('2 thay đổi bị từ chối');
  });
});

describe('cardState (7 trạng thái C4)', () => {
  it('cài được · đã cài · có bản mới · bản mới đã tải', () => {
    expect(cardState(item({}), undefined, false)).toBe('installable');
    expect(cardState(item({ action: 'open' }), undefined, false)).toBe('installed');
    expect(cardState(item({ action: 'update' }), undefined, false)).toBe('update');
    expect(cardState(item({ action: 'update', local: { pending_version: '0.3.0' } as never }), undefined, false)).toBe('pending-update');
  });
  it('đang tải · không có bản an toàn · hết quota · chỉ bản cache', () => {
    expect(cardState(item({}), { step: 'verify' }, false)).toBe('installing');
    expect(cardState(item({}), { step: 'verify', error: { code: 'PACKAGE_TAMPERED', message: '' } }, false)).toBe('installing');
    expect(cardState(item({ action: 'unavailable', code: 'NO_SAFE_VERSION' }), undefined, false)).toBe('unsafe');
    expect(cardState(item({ code: 'QUOTA_EXCEEDED' }), undefined, false)).toBe('quota');
    expect(cardState(item({}), { step: 'download', error: { code: 'QUOTA_EXCEEDED', message: '' } }, false)).toBe('quota');
    expect(cardState(item({}), undefined, true)).toBe('cache-offline');
  });
  it('đã gỡ còn dữ liệu → cài lại', () => {
    expect(cardState(item({ uninstalledWithData: true }), undefined, false)).toBe('removed');
  });
});
