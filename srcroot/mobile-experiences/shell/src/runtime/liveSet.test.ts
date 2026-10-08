import { LiveSet } from './liveSet';

test('AC-14: mở 4 app liên tiếp ⇒ app cũ nhất bị chọn huỷ, app vừa mở không bao giờ', () => {
  const s = new LiveSet(3);
  expect(s.open('a')).toEqual({ resumed: false, evict: [] });
  expect(s.open('b').evict).toEqual([]);
  expect(s.open('c').evict).toEqual([]);
  const r = s.open('d');
  expect(r.evict).toEqual(['a']);
  expect(s.foreground).toBe('d');
  s.remove('a');
  expect(s.live).toEqual(['b', 'c', 'd']);
});
test('quay lại app còn sống ⇒ resumed, không huỷ ai', () => {
  const s = new LiveSet(3);
  s.open('a'); s.open('b'); s.open('c');
  s.closeForeground();
  expect(s.open('a')).toEqual({ resumed: true, evict: [] });
  expect(s.live).toEqual(['b', 'c', 'a']);
});
test('mở app đã bị huỷ ⇒ nạp mới (resumed=false)', () => {
  const s = new LiveSet(3);
  s.open('a'); s.open('b'); s.open('c'); s.open('d'); s.remove('a');
  expect(s.open('a').resumed).toBe(false);
});
test('nạp nền không cướp chỗ app đang hiện', () => {
  const s = new LiveSet(3);
  s.open('a'); s.open('b');
  expect(s.openBackground('c').evict).toEqual([]);
  expect(s.live[s.live.length - 1]).toBe('b');
  const r = s.openBackground('d');
  expect(r.evict).toEqual(['a']);
  expect(s.foreground).toBe('b');
});
