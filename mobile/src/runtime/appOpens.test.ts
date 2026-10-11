import { noteAppOpen } from './appOpens';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('noteAppOpen', () => {
  it('xin token cho đúng app', async () => {
    const got: string[] = [];
    noteAppOpen(async (id) => void got.push(id), 'vn.app.note');
    await flush();
    expect(got).toEqual(['vn.app.note']);
  });
  it('lỗi mạng / ném đồng bộ KHÔNG nổ ra ngoài và không chặn người gọi', async () => {
    expect(() => noteAppOpen(() => Promise.reject(new Error('OFFLINE')), 'a.b.c')).not.toThrow();
    expect(() =>
      noteAppOpen(() => {
        throw new Error('boom');
      }, 'a.b.c'),
    ).not.toThrow();
    await flush();
  });
  it('trả về ngay (không đợi token)', () => {
    let resolved = false;
    noteAppOpen(() => new Promise(() => undefined), 'a.b.c');
    resolved = true;
    expect(resolved).toBe(true);
  });
});
