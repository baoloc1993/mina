// Thông báo cục bộ (CAP-RT-05, AC-7): đặt bằng expo-notifications (kêu khi shell tắt + máy offline), nhớ trong
// `platform_notifications` để đặt lại sau khi mở shell. Quyền bị từ chối ⇒ PERMISSION_DENIED.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { AbstractPowerSyncDatabase } from '@powersync/common';
import { BridgeError } from '../bridge/types';

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
  // Giữ ≤ 50 gần nhất mỗi app.
  const extra = await db.getAll<{ id: string; os_id: string }>(
    'SELECT id, os_id FROM platform_notifications WHERE app_id = ? ORDER BY at DESC LIMIT -1 OFFSET ?',
    [appId, MAX_PER_APP],
  );
  for (const e of extra) {
    await Notifications.cancelScheduledNotificationAsync(e.os_id).catch(() => undefined);
    await db.execute('DELETE FROM platform_notifications WHERE id = ?', [e.id]);
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

/** Sau khi mở shell: đặt lại thông báo tương lai còn thiếu (vd sau khi máy khởi động lại). */
export async function restoreNotifications(db: AbstractPowerSyncDatabase): Promise<void> {
  const rows = await db.getAll<{ id: string; app_id: string; at: number; title: string; body: string; ref: string | null; os_id: string }>(
    'SELECT * FROM platform_notifications WHERE at > ?',
    [Date.now()],
  );
  if (!rows.length) return;
  await init();
  const live = new Set((await Notifications.getAllScheduledNotificationsAsync()).map((n) => n.identifier));
  for (const r of rows) {
    if (live.has(r.os_id)) continue;
    const osId = await osSchedule(r.app_id, { id: r.id.slice(r.app_id.length + 1), at: r.at, title: r.title, body: r.body, ref: r.ref });
    await db.execute('UPDATE platform_notifications SET os_id = ? WHERE id = ?', [osId, r.id]);
  }
}

/** Người dùng bấm thông báo ⇒ gọi `cb({appId, ref})` (mở app + giao `ref`). */
export function onNotificationTap(cb: (info: { appId: string; ref: string | null }) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const d = resp.notification.request.content.data as { appId?: string; ref?: string | null };
    if (d?.appId) cb({ appId: d.appId, ref: d.ref ?? null });
  });
  return () => sub.remove();
}
