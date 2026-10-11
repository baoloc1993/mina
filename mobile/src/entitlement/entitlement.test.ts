import { buildCache, EntitlementStore, evaluate, type Clock } from './entitlement';

const DAY = 86_400_000;
function clock(start = { mono: 1_000_000, wall: Date.parse('2026-10-09T00:00:00Z') }) {
  const c = { ...start };
  const clk: Clock & { advance(ms: number): void; reboot(): void; setWall(ms: number): void } = {
    monotonicMs: () => c.mono,
    wallMs: () => c.wall,
    advance: (ms) => {
      c.mono += ms;
      c.wall += ms;
    },
    reboot: () => {
      c.mono = 5_000; // đồng hồ đơn điệu về gần 0 sau khi khởi động lại
    },
    setWall: (ms) => {
      c.wall = ms;
    },
  };
  return clk;
}
const T0 = '2026-10-09T00:00:00Z';
const ent = (until: string | null) => ({ plan: 'mvp-unlimited', max_apps: null, until });

describe('AC-13 entitlement', () => {
  test('chưa có cache → không chỉ đọc', () => {
    expect(evaluate(null, clock()).readOnly).toBe(false);
  });
  test('until null (mvp-unlimited) → không bao giờ chỉ đọc, dù qua 100 ngày', () => {
    const k = clock();
    const c = buildCache(ent(null), T0, k);
    k.advance(100 * DAY);
    expect(evaluate(c, k)).toMatchObject({ readOnly: false, reason: 'unlimited' });
  });
  test('gói còn hạn → bình thường', () => {
    const k = clock();
    const c = buildCache(ent('2026-12-01T00:00:00Z'), T0, k);
    k.advance(10 * DAY);
    expect(evaluate(c, k)).toMatchObject({ readOnly: false, expired: false });
  });
  test('quá hạn gói nhưng trong 7 ngày ân hạn → vẫn ghi được, báo còn bao lâu', () => {
    const k = clock();
    const c = buildCache(ent('2026-10-05T00:00:00Z'), T0, k); // hạn đã qua 4 ngày khi xác minh
    const s = evaluate(c, k);
    expect(s).toMatchObject({ readOnly: false, expired: true, reason: 'in-grace' });
    expect(Math.round((s.graceLeftMs as number) / DAY)).toBe(3);
  });
  test('quá 7 ngày ân hạn (mô phỏng bằng đồng hồ đơn điệu) → chỉ đọc', () => {
    const k = clock();
    const c = buildCache(ent('2026-10-05T00:00:00Z'), T0, k);
    k.advance(3 * DAY + 1000);
    expect(evaluate(c, k)).toMatchObject({ readOnly: true, reason: 'grace-over' });
  });
  test('đã quá 7 ngày ngay lúc xác minh (set-entitlement quá khứ xa) → chỉ đọc luôn', () => {
    const k = clock();
    expect(evaluate(buildCache(ent('2026-09-01T00:00:00Z'), T0, k), k).readOnly).toBe(true);
  });
  test('chỉnh đồng hồ máy LÙI không kéo dài ân hạn', () => {
    const k = clock();
    const c = buildCache(ent('2026-10-05T00:00:00Z'), T0, k);
    k.advance(4 * DAY); // quá ân hạn
    expect(evaluate(c, k).readOnly).toBe(true);
    k.setWall(Date.parse('2026-10-09T00:00:00Z') - DAY); // lùi trước lần xác minh
    expect(evaluate(c, k)).toMatchObject({ readOnly: true, reason: 'clock-rolled-back' });
  });
  test('chỉnh đồng hồ lùi nhưng vẫn sau lần xác minh → đồng hồ đơn điệu vẫn thắng', () => {
    const k = clock();
    const c = buildCache(ent('2026-10-05T00:00:00Z'), T0, k);
    k.advance(4 * DAY);
    k.setWall(Date.parse(T0) + 1000); // lùi gần về lúc xác minh
    expect(evaluate(c, k).readOnly).toBe(true);
  });
  test('khởi động lại máy: đồng hồ đơn điệu về 0 → dùng đồng hồ treo tường (không lùi)', () => {
    const k = clock();
    const c = buildCache(ent('2026-10-05T00:00:00Z'), T0, k);
    k.advance(4 * DAY);
    k.reboot();
    expect(evaluate(c, k).readOnly).toBe(true);
  });
  test('server đã trả 403 READ_ONLY → chỉ đọc dù cache cục bộ nói còn hạn; verified() xoá cờ', async () => {
    const k = clock();
    const s = new EntitlementStore(k);
    await s.verified(ent('2027-01-01T00:00:00Z'), T0);
    expect(s.isReadOnly()).toBe(false);
    s.markServerReadOnly();
    expect(s.isReadOnly()).toBe(true);
    await s.verified(ent(null), T0); // set-entitlement null rồi online lại
    expect(s.isReadOnly()).toBe(false);
  });
  test('verified() phát sự kiện và lưu', async () => {
    const k = clock();
    const saved: unknown[] = [];
    const s = new EntitlementStore(k, async (c) => void saved.push(c));
    let n = 0;
    s.subscribe(() => n++);
    await s.verified(ent('2026-09-01T00:00:00Z'), T0);
    expect(n).toBe(1);
    expect(saved).toHaveLength(1);
    expect(s.state.readOnly).toBe(true);
  });
});
