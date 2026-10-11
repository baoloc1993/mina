import { NotifyReconciler } from './notifyReconcile';

const A = 'vn.app.cal';

test('đổi chữ ký 2 lần cách 5 s: lần 1 chạy ngay, lần 2 chạy đúng 1 lần ở nhịp đầu sau 30 s', () => {
  const r = new NotifyReconciler();
  expect(r.decide(0, A, 's0', false)).toBe('none'); // lần đầu thấy: chưa có gì để so
  expect(r.decide(5_000, A, 's1', false)).toBe('load');
  r.loadFinished(5_000, A, true);
  expect(r.decide(10_000, A, 's2', false)).toBe('none'); // bẩn, trong cửa sổ 30 s
  let loads = 0;
  for (let t = 15_000; t < 35_000; t += 5_000) if (r.decide(t, A, 's2', false) === 'load') loads++;
  expect(loads).toBe(0);
  expect(r.decide(35_000, A, 's2', false)).toBe('load'); // đuôi throttle
  r.loadFinished(35_000, A, true);
  expect(r.decide(40_000, A, 's2', false)).toBe('none');
});

test('lần đồng bộ đầu của phiên ⇒ nạp 1 lần, rồi thôi', () => {
  const r = new NotifyReconciler();
  expect(r.decide(0, A, 's0', false)).toBe('none');
  r.markFirstSync();
  expect(r.decide(5_000, A, 's0', false)).toBe('load');
  r.loadFinished(5_000, A, true);
  expect(r.decide(40_000, A, 's0', false)).toBe('none');
});

test('app đang sống ⇒ emit-sync khi đổi, không bao giờ load', () => {
  const r = new NotifyReconciler();
  r.markFirstSync();
  expect(r.decide(0, A, 's0', true)).toBe('none');
  expect(r.decide(5_000, A, 's1', true)).toBe('emit-sync');
  expect(r.decide(10_000, A, 's1', true)).toBe('none');
});

test('không đổi ⇒ không làm gì; chữ ký null ⇒ bỏ qua nhịp', () => {
  const r = new NotifyReconciler();
  expect(r.decide(0, A, 's0', false)).toBe('none');
  expect(r.decide(5_000, A, null, false)).toBe('none');
  expect(r.decide(10_000, A, 's0', false)).toBe('none');
});

test('lỗi nạp ⇒ giữ bẩn, thử lại sau throttle', () => {
  const r = new NotifyReconciler();
  r.decide(0, A, 's0', false);
  expect(r.decide(5_000, A, 's1', false)).toBe('load');
  r.loadFinished(5_000, A, false);
  expect(r.decide(10_000, A, 's1', false)).toBe('none');
  expect(r.decide(35_000, A, 's1', false)).toBe('load');
});

test('reset khi đổi phiên: quên chữ ký, bẩn, lần đồng bộ đầu', () => {
  const r = new NotifyReconciler();
  r.decide(0, A, 's0', false);
  r.markFirstSync();
  r.reset();
  expect(r.decide(100_000, A, 's9', false)).toBe('none');
  r.markFirstSync();
  expect(r.decide(105_000, A, 's9', false)).toBe('load');
});
