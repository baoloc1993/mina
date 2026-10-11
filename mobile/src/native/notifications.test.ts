// Đặt lại thông báo sau force-stop + giao lần bấm thông báo (dogfood vòng 7). Mock expo-notifications / react-native.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  AndroidImportance: { HIGH: 4 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
  getLastNotificationResponseAsync: jest.fn(),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
  addNotificationResponseReceivedListener: jest.fn(),
}));

import * as N from 'expo-notifications';
import { restoreNotifications, takeLastNotificationTap } from './notifications';

type Row = { id: string; app_id: string; at: number; title: string; body: string; ref: string | null; os_id: string };
const mocked = N as unknown as {
  scheduleNotificationAsync: jest.Mock; cancelScheduledNotificationAsync: jest.Mock;
  getAllScheduledNotificationsAsync: jest.Mock; getLastNotificationResponseAsync: jest.Mock;
};

/** DB giả tối thiểu: chỉ hiểu 3 câu SQL mà restoreNotifications dùng. */
function fakeDb(rows: Row[]) {
  const executed: { sql: string; params: unknown[] }[] = [];
  return {
    executed,
    db: {
      getAll: async (sql: string, p: number[]) => (sql.includes('WHERE at > ?') ? rows.filter((r) => r.at > p[0]) : []),
      execute: async (sql: string, params: unknown[] = []) => { executed.push({ sql, params }); },
    } as never,
  };
}
const row = (id: string, at: number): Row => ({ id: `vn.app.cal:${id}`, app_id: 'vn.app.cal', at, title: 't', body: 'b', ref: null, os_id: `old-${id}` });

beforeEach(() => {
  jest.clearAllMocks();
  let n = 0;
  mocked.scheduleNotificationAsync.mockImplementation(async () => `new-${++n}`);
});

describe('restoreNotifications', () => {
  test('đặt lại MỌI dòng tương lai kể cả khi expo vẫn liệt kê chúng (force-stop xoá alarm OS nhưng không xoá danh sách expo)', async () => {
    mocked.getAllScheduledNotificationsAsync.mockResolvedValue([{ identifier: 'old-a' }, { identifier: 'old-b' }]);
    const { db, executed } = fakeDb([row('a', Date.now() + 60_000), row('b', Date.now() + 120_000)]);
    await restoreNotifications(db);
    expect(mocked.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
    expect(mocked.cancelScheduledNotificationAsync).toHaveBeenCalledWith('old-a'); // huỷ bản cũ trước khi đặt lại
    const updates = executed.filter((e) => e.sql.startsWith('UPDATE'));
    expect(updates.map((u) => u.params)).toEqual([['new-1', 'vn.app.cal:a'], ['new-2', 'vn.app.cal:b']]);
  });

  test('không đặt lại dòng đã qua, và dọn dòng quá 1 ngày', async () => {
    const { db, executed } = fakeDb([row('past', Date.now() - 5_000)]);
    await restoreNotifications(db);
    expect(mocked.scheduleNotificationAsync).not.toHaveBeenCalled();
    const del = executed.find((e) => e.sql.startsWith('DELETE'));
    expect(del).toBeDefined();
    const cutoff = del!.params[0] as number;
    expect(Math.abs(cutoff - (Date.now() - 86_400_000))).toBeLessThan(5_000);
  });

  test('id gốc của app được giữ nguyên khi đặt lại (data.id không dính tiền tố app)', async () => {
    const { db } = fakeDb([row('evt-1', Date.now() + 60_000)]);
    await restoreNotifications(db);
    const arg = mocked.scheduleNotificationAsync.mock.calls[0][0];
    expect(arg.content.data).toEqual({ appId: 'vn.app.cal', id: 'evt-1', ref: null });
  });
});

describe('takeLastNotificationTap', () => {
  const resp = (id: string, date = 1, appId: string | null = 'vn.app.cal') => ({
    notification: { date, request: { identifier: id, content: { data: { appId: appId ?? undefined, ref: 'r1' } } } },
    actionIdentifier: 'default',
  });

  test('cùng một lần bấm chỉ giao một lần; lần bấm khác id thì giao tiếp', async () => {
    mocked.getLastNotificationResponseAsync.mockResolvedValue(resp('n-1'));
    expect(await takeLastNotificationTap()).toEqual({ appId: 'vn.app.cal', ref: 'r1' });
    expect(await takeLastNotificationTap()).toBeNull();
    mocked.getLastNotificationResponseAsync.mockResolvedValue(resp('n-2'));
    expect(await takeLastNotificationTap()).toEqual({ appId: 'vn.app.cal', ref: 'r1' });
  });

  test('chưa có lần bấm nào, hoặc API lỗi ⇒ null, không ném', async () => {
    mocked.getLastNotificationResponseAsync.mockResolvedValue(null);
    expect(await takeLastNotificationTap()).toBeNull();
    mocked.getLastNotificationResponseAsync.mockRejectedValue(new Error('boom'));
    expect(await takeLastNotificationTap()).toBeNull();
  });

  test('thông báo không mang appId ⇒ không mở app nào', async () => {
    mocked.getLastNotificationResponseAsync.mockResolvedValue(resp('n-3', 1, null));
    expect(await takeLastNotificationTap()).toBeNull();
  });
});
