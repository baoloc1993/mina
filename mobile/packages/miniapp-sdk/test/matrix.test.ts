// AC-9 / AC-15 phía mock SDK: cùng bảng kỳ vọng với Jest của shell (src/bridge/matrix.ts), đóng băng ở matrix.expected.ts.
import { describe, expect, test } from 'vitest';
import { METHOD_TABLE } from '../../../src/bridge/bridge';
import { CASES, summarizeMatrix } from '../../../src/bridge/matrix';
import { EXPECTED_SUMMARY } from '../../../src/bridge/matrix.expected';

describe('ma trận scope (mock SDK dùng đúng bridge của shell)', () => {
  test('summarizeMatrix() khớp bảng kỳ vọng đóng băng, từng dòng', async () => {
    expect(await summarizeMatrix()).toEqual(EXPECTED_SUMMARY);
  });

  test('bảng kỳ vọng phủ mọi ca của matrix.ts và tuân quy tắc bất biến', () => {
    expect(EXPECTED_SUMMARY.map((l) => l.split('|')[0])).toEqual(CASES.map((c) => c.method));
    for (const line of EXPECTED_SUMMARY) {
      const [method, none, ok, ro] = line.split('|');
      const c = CASES.find((x) => x.method === method)!;
      expect(none, `${method} thiếu scope`).toBe(c.grants.length ? 'SCOPE_DENIED' : 'OK');
      expect(ok, `${method} có scope`).toBe('OK');
      expect(ro, `${method} chỉ đọc`).toBe(c.writes ? 'READ_ONLY' : 'OK');
    }
    // sdk.* và sync.status luôn OK, kể cả chỉ đọc
    for (const m of ['sdk.ready', 'sdk.info', 'sync.status']) expect(EXPECTED_SUMMARY.find((l) => l.startsWith(`${m}|`))).toBe(`${m}|OK|OK|OK`);
  });

  test('chỉ method không có ca (sdk.suspended, core.files.get) nằm ngoài bảng', () => {
    const covered = new Set(CASES.map((c) => c.method));
    expect(METHOD_TABLE.map((m) => m.method).filter((m) => !covered.has(m)).sort()).toEqual(['core.files.get', 'sdk.suspended']);
  });
});
