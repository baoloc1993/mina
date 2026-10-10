import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "../ops-report.ts";

const day = (d: string, opens = 1) => ({ day: d, opens, apps: ["vn.app.note"] });

test("summarize: đếm ngày dùng, ngày trống, chuỗi dài nhất", () => {
  const s = summarize("2026-11-01", 7, [day("2026-11-01"), day("2026-11-02"), day("2026-11-04"), day("2026-11-05"), day("2026-11-06")]);
  assert.equal(s.used, 5);
  assert.deepEqual(s.missing, ["2026-11-03", "2026-11-07"]);
  assert.equal(s.longestStreak, 3);
  assert.equal(s.window.length, 7);
});

test("summarize: dòng opens = 0 không tính là ngày dùng; ngoài cửa sổ bị bỏ", () => {
  const s = summarize("2026-11-01", 3, [day("2026-11-01", 0), day("2026-10-31"), day("2026-11-02")]);
  assert.equal(s.used, 1);
});

test("summarize: phán quyết chỉ khi đủ 28 ngày; 24 ⇒ GO, 15..23 ⇒ PIVOT, ≤ 14 ⇒ KILL (PRD §6)", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => day(new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10)));
  assert.match(summarize("2026-11-01", 20, mk(20)).verdict, /chưa đủ 28/);
  assert.match(summarize("2026-11-01", 28, mk(24)).verdict, /GO/);
  assert.match(summarize("2026-11-01", 28, mk(23)).verdict, /PIVOT/);
  assert.match(summarize("2026-11-01", 28, mk(15)).verdict, /PIVOT/);
  assert.match(summarize("2026-11-01", 28, mk(14)).verdict, /KILL/);
});
