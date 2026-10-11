// Suy trạng thái thẻ catalog C4 từ dữ liệu runtime. Thuần TS (test được).
import type { CatalogItem, InstallProgress as Progress } from '../runtime/types';

export type CardState = 'installable' | 'installed' | 'update' | 'installing' | 'unsafe' | 'quota' | 'cache-offline' | 'removed' | 'pending-update';

export function cardState(item: CatalogItem, progress: Progress | undefined, fromCache: boolean): CardState {
  const quota = item.code === 'QUOTA_EXCEEDED' || progress?.error?.code === 'QUOTA_EXCEEDED';
  if (progress && !progress.error) return 'installing';
  if (quota && item.action !== 'open') return 'quota';
  if (progress?.error) return 'installing'; // lỗi cài khác: C12 trạng thái lỗi + Thử lại
  if (item.action === 'unavailable') return 'unsafe';
  if (item.action === 'open') return 'installed';
  if (item.action === 'update') return item.local?.pending_version ? 'pending-update' : fromCache ? 'cache-offline' : 'update';
  if (fromCache) return 'cache-offline';
  if (item.uninstalledWithData) return 'removed';
  return 'installable';
}

