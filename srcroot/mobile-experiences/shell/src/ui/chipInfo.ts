// C6 chip trạng thái sync — phần thuần (không kéo React Native) để test được bằng Jest.
import type { SyncState } from '../bridge/types';
import type { Tone } from './Txt';

export function chipInfo(state: SyncState, rejected: number): { tone: Tone; text: string } {
  switch (state) {
    case 'online':
      return { tone: 'success', text: 'Đã đồng bộ' };
    case 'syncing':
      return { tone: 'primary', text: 'Đang đồng bộ…' };
    case 'offline':
      return { tone: 'warning', text: 'Offline' };
    case 'error':
      // `error` còn xảy ra khi LẦN GỬI lỗi (mạng chập chờn, 429) mà chưa có dòng nào bị từ chối: không được gọi là "bị từ chối"
      // (dogfood vòng 7 — S6 vừa báo "1 bị từ chối" vừa "Không có thay đổi nào bị từ chối").
      return rejected > 0 ? { tone: 'danger', text: `${rejected} bị từ chối` } : { tone: 'warning', text: 'Chưa gửi được — sẽ thử lại' };
  }
}
