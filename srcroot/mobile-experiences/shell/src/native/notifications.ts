// Thông báo cục bộ (CAP-RT-05, AC-7): đặt bằng expo-notifications (kêu khi shell tắt + máy offline), nhớ trong
// `platform_notifications` để đặt lại sau khi mở shell. Quyền bị từ chối ⇒ PERMISSION_DENIED.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { AbstractPowerSyncDatabase } from '@powersync/common';
import { BridgeError } from '../bridge/types';
import { pickEvictions } from './notifyEvict';

const CHANNEL = 'mina-default';
export const MAX_PER_APP = 50;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

let ready: Promise<void> | null = null;
function init(): Promise<void> {
  ready ??= (async () => {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Nhắc việc',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
  })();
  return ready;
}

async function ensurePermission(): Promise<void> {
  await init();
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return;
  const asked = await Notifications.requestPermissionsAsync();
  if (!asked.granted) throw new BridgeError('PERMISSION_DENIED', 'Người dùng chưa cho phép thông báo');
}

export interface NotifyItem {
  id: string;
  at: number;
  title: string;
  body: string;
  ref: string | null;
}

const key = (appId: string, id: string) => `${appId}:${id}`;

async function osSchedule(appId: string, n: NotifyItem): Promise<string> {
  const content = { title: n.title, body: n.body, data: { appId, id: n.id, ref: n.ref } };
  const when = new Date(n.at);
  if (n.at <= Date.now() + 1000) {
    // Trong quá khứ ⇒ kêu ngay.
    return Notifications.scheduleNotificationAsync({ content, trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null });
  }
  return Notifications.scheduleNotificationAsync({
    content,
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when, channelId: CHANNEL },
  });
}

export async function scheduleNotification(db: AbstractPowerSyncDatabase, appId: string, n: NotifyItem): Promise<void> {
  await ensurePermission();
  const prev = await db.getOptional<{ os_id: string }>('SELECT os_id FROM platform_notifications WHERE id = ?', [key(appId, n.id)]);
  if (prev?.os_id) await Notifications.cancelScheduledNotificationAsync(prev.os_id).catch(() => undefined);
  const osId = await osSchedule(appId, n);
  await db.execute(
    'INSERT OR REPLACE INTO platform_notifications (id, app_id, at, title, body, ref, os_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [key(appId, n.id), appId, n.at, n.title, n.body, n.ref, osId],
  );
  await trimApp(db, appId);
}

/** Mỗi app giữ ≤ 50 thông báo SẮP TỚI gần nhất; dọn dòng đã qua > 1 ngày (chọn bằng hàm thuần `pickEvictions`). */
async function trimApp(db: AbstractPowerSyncDatabase, appId: string): Promise<void> {
  const rows = await db.getAll<{ id: string; at: number; os_id: string }>('SELECT id, at, os_id FROM platform_notifications WHERE app_id = ?', [appId]);
  const { drop } = pickEvictions(rows, Date.now(), MAX_PER_APP);
  for (const id of drop) {
    const r = rows.find((x) => x.id === id);
    if (r?.os_id) await Notifications.cancelScheduledNotificationAsync(r.os_id).catch(() => undefined);
    await db.execute('DELETE FROM platform_notifications WHERE id = ?', [id]);
  }
}

export async function cancelNotification(db: AbstractPowerSyncDatabase, appId: string, id: string): Promise<void> {
  const prev = await db.getOptional<{ os_id: string }>('SELECT os_id FROM platform_notifications WHERE id = ?', [key(appId, id)]);
  if (prev?.os_id) await Notifications.cancelScheduledNotificationAsync(prev.os_id).catch(() => undefined);
  await db.execute('DELETE FROM platform_notifications WHERE id = ?', [key(appId, id)]);
}

export async function listNotifications(db: AbstractPowerSyncDatabase, appId: string): Promise<NotifyItem[]> {
  const rows = await db.getAll<{ id: string; at: number; title: string; body: string; ref: string | null }>(
    'SELECT id, at, title, body, ref FROM platform_notifications WHERE app_id = ? ORDER BY at',
    [appId],
  );
  return rows.map((r) => ({ id: r.id.slice(appId.length + 1), at: r.at, title: r.title, body: r.body, ref: r.ref }));
}

/** Gỡ mọi thông báo của một app (khi gỡ app). */
export async function cancelAllOf(db: AbstractPowerSyncDatabase, appId: string): Promise<void> {
  const rows = await db.getAll<{ os_id: string }>('SELECT os_id FROM platform_notifications WHERE app_id = ?', [appId]);
  for (const r of rows) await Notifications.cancelScheduledNotificationAsync(r.os_id).catch(() => undefined);
  await db.execute('DELETE FROM platform_notifications WHERE app_id = ?', [appId]);
}

/**
 * Sau khi mở shell: ĐẶT LẠI mọi thông báo tương lai. Không được bỏ qua dòng mà expo còn "nhớ" (`getAllScheduledNotificationsAsync`):
 * `force-stop` xoá alarm của hệ điều hành nhưng danh sách của expo vẫn còn dòng ấy ⇒ bản cũ coi là "đang sống" và KHÔNG đặt lại,
 * lời nhắc im lặng (dogfood vòng 7). Huỷ bản cũ (nếu còn) rồi đặt lại là idempotent.
 */
export async function restoreNotifications(db: AbstractPowerSyncDatabase): Promise<void> {
  const rows = await db.getAll<{ id: string; app_id: string; at: number; title: string; body: string; ref: string | null; os_id: string }>(
    'SELECT * FROM platform_notifications WHERE at > ?',
    [Date.now()],
  );
  await db.execute('DELETE FROM platform_notifications WHERE at < ?', [Date.now() - 86_400_000]);
  if (!rows.length) return;
  await init();
  for (const r of rows) {
    if (r.os_id) await Notifications.cancelScheduledNotificationAsync(r.os_id).catch(() => undefined);
    const osId = await osSchedule(r.app_id, { id: r.id.slice(r.app_id.length + 1), at: r.at, title: r.title, body: r.body, ref: r.ref });
    await db.execute('UPDATE platform_notifications SET os_id = ? WHERE id = ?', [osId, r.id]);
  }
}

let lastTapKey = '';
type TapInfo = { appId: string; ref: string | null };
const tapKey = (r: Notifications.NotificationResponse) => `${r.notification.request.identifier}|${r.notification.date}|${r.actionIdentifier}`;
function tapOf(r: Notifications.NotificationResponse): TapInfo | null {
  const d = r.notification.request.content.data as { appId?: string; ref?: string | null };
  return d?.appId ? { appId: d.appId, ref: d.ref ?? null } : null;
}

/** Người dùng bấm thông báo ⇒ gọi `cb({appId, ref})` (mở app + giao `ref`). Mỗi lần bấm chỉ giao MỘT lần (khoá theo id + giờ + hành động). */
export function onNotificationTap(cb: (info: TapInfo) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const k = tapKey(resp);
    if (k === lastTapKey) return;
    lastTapKey = k;
    const t = tapOf(resp);
    if (t) cb(t);
  });
  return () => sub.remove();
}

/**
 * Lần bấm đã MỞ shell từ trạng thái chết: phản hồi tới trước khi listener được gắn nên listener không thấy (dogfood vòng 7 — bấm thông báo
 * khi shell đã bị kill chỉ ra launcher). Hỏi `getLastNotificationResponse` sau khi khởi động xong; đã giao rồi (cùng khoá) thì bỏ qua.
 */
export async function takeLastNotificationTap(): Promise<TapInfo | null> {
  const resp = await Notifications.getLastNotificationResponseAsync().catch(() => null);
  if (!resp) return null;
  const k = tapKey(resp);
  if (k === lastTapKey) return null;
  lastTapKey = k;
  return tapOf(resp);
}
