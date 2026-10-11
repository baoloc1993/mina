import { chipInfo } from './chipInfo';

describe('chipInfo', () => {
  it('đủ bốn trạng thái', () => {
    expect(chipInfo('online', 0).text).toBe('Đã đồng bộ');
    expect(chipInfo('syncing', 0).text).toBe('Đang đồng bộ…');
    expect(chipInfo('offline', 0).text).toBe('Offline');
  });
  it('error có dòng bị từ chối → "N bị từ chối" (danger)', () => {
    expect(chipInfo('error', 3)).toEqual({ tone: 'danger', text: '3 bị từ chối' });
  });
  it('error nhưng 0 dòng bị từ chối (lần gửi lỗi/mạng) → KHÔNG nói "bị từ chối"', () => {
    const c = chipInfo('error', 0);
    expect(c.text).not.toMatch(/từ chối/);
    expect(c.tone).toBe('warning');
  });
});
