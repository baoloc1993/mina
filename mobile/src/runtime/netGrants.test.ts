import { configNetwork, configOf, extraHostsOf, hostGroups, hostSubtitle, liveGrants } from './netGrants';

const row = (app_id: string, host: string, created_at: string | null = '2026-10-09T01:00:00Z') => ({ app_id, host, created_at });

describe('liveGrants', () => {
  test('gộp dòng trùng (app, host) do hai máy cùng cho phép; giữ mốc sớm nhất', () => {
    const g = liveGrants([row('vn.app.news', 'a.vn', '2026-10-09T05:00:00Z'), row('vn.app.news', 'a.vn', '2026-10-09T01:00:00Z'), row('vn.app.news', 'b.vn')]);
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.host === 'a.vn')?.since).toBe('2026-10-09T01:00:00Z');
  });
  test('dòng hỏng (host sai khuôn, wildcard, scheme, chữ hoa) không bao giờ mở cửa', () => {
    const bad = ['*.a.vn', 'https://a.vn', 'A.VN', 'a.vn/x', 'u:p@a.vn', '', 'a b', 'a.vn:99999'];
    expect(liveGrants(bad.map((h) => row('vn.app.news', h)))).toEqual([]);
  });
  test('grant theo app: cùng host nhưng hai app là hai mục', () => {
    expect(liveGrants([row('vn.app.news', 'a.vn'), row('vn.app.other', 'a.vn')])).toHaveLength(2);
  });
});

describe('extraHostsOf', () => {
  const grants = liveGrants([row('vn.app.news', 'blog.example.dev'), row('vn.app.other', 'evil.example')]);
  test('config.network ∪ grant của ĐÚNG app; app khác không hưởng', () => {
    expect(extraHostsOf('vn.app.news', { network: ['vnexpress.net'] }, grants).sort()).toEqual(['blog.example.dev', 'vnexpress.net']);
    expect(extraHostsOf('vn.app.news', {}, grants)).toEqual(['blog.example.dev']);
    expect(extraHostsOf('vn.app.third', { network: [] }, grants)).toEqual([]);
  });
  test('config.network rác (không mảng, host sai) bị bỏ, không ném', () => {
    expect(configNetwork({ network: 'a.vn' })).toEqual([]);
    expect(configNetwork({ network: ['ok.vn', 5, '*.x.vn', 'HTTP://a'] })).toEqual(['ok.vn']);
    expect(configNetwork(null)).toEqual([]);
    expect(configNetwork({ network: ['a.vn', 'a.vn'] })).toEqual(['a.vn']);
  });
  test('thu hồi: bỏ grant khỏi danh sách → host hết có mặt', () => {
    expect(extraHostsOf('vn.app.news', {}, [])).toEqual([]);
  });
});

describe('configOf', () => {
  test('chỉ nhận object thuần', () => {
    expect(configOf({ a: 1 })).toEqual({ a: 1 });
    for (const x of [null, undefined, [], 'x', 5]) expect(configOf(x)).toEqual({});
  });
});

describe('hostGroups (S4)', () => {
  test('ba nhóm, mỗi host một nhóm (manifest > cấu hình > người dùng)', () => {
    const grants = liveGrants([row('vn.app.news', 'blog.example.dev'), row('vn.app.news', 'vnexpress.net'), row('vn.app.news', 'm.vn')]);
    const g = hostGroups(['m.vn'], { network: ['vnexpress.net', 'tuoitre.vn'] }, grants, 'vn.app.news');
    expect(g.manifest).toEqual(['m.vn']);
    expect(g.config).toEqual(['vnexpress.net', 'tuoitre.vn']);
    expect(g.user.map((x) => x.host)).toEqual(['blog.example.dev']);
  });
  test('nhãn phụ', () => {
    expect(hostSubtitle('manifest')).toBe('theo app');
    expect(hostSubtitle('config')).toBe('theo cấu hình');
    expect(hostSubtitle('user', '2026-10-09T12:00:00Z')).toMatch(/^bạn cho phép \d{2}\/\d{2}$/);
    expect(hostSubtitle('user')).toBe('bạn cho phép');
  });
});
