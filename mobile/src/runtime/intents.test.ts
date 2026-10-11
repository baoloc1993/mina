import { receiversOf } from './intents';
import type { AppRow } from '../packages/types';

const app = (id: string, installed: string, status: AppRow['status'], recv: { type: string; version: string }[]): AppRow =>
  ({ app_id: id, installed_at: installed, status, manifest: { intents: { receives: recv.map((r) => ({ ...r, schema: {} })) } } }) as unknown as AppRow;

test('chỉ app đã cài và chưa bị thu hồi; app cài trước đứng đầu', () => {
  const apps = [
    app('b', '2026-01-02', 'ok', [{ type: 't', version: '1' }]),
    app('a', '2026-01-01', 'ok', [{ type: 't', version: '1' }]),
    app('c', '2026-01-03', 'revoked', [{ type: 't', version: '1' }]),
    app('d', '2026-01-04', 'ok', [{ type: 'khác', version: '1' }]),
  ];
  expect(receiversOf(apps, 't', '1').map((r) => r.appId)).toEqual(['a', 'b']);
  expect(receiversOf(apps, 't', '2')).toEqual([]);
  expect(receiversOf(apps, 't', null).map((r) => r.appId)).toEqual(['a', 'b']);
});
