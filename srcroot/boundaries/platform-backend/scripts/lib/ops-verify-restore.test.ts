import assert from "node:assert/strict";
import { test } from "node:test";
import { judge } from "../ops-verify-restore.ts";

test("judge: bằng nhau → khớp", () => {
  const [v] = judge([{ table: "public.core_tags", source: 10, restored: 10, late: 0 }]);
  assert.equal(v.ok, true);
  assert.equal(v.note, "khớp");
});

test("judge: lệch đúng bằng số dòng ghi sau mốc backup → chấp nhận và nêu rõ", () => {
  const [v] = judge([{ table: "public.x", source: 15, restored: 12, late: 3 }]);
  assert.equal(v.ok, true);
  assert.match(v.note, /3 dòng ghi sau giờ backup/);
});

test("judge: thiếu nhiều hơn số dòng ghi sau mốc → LỆCH", () => {
  const [v] = judge([{ table: "public.x", source: 15, restored: 10, late: 3 }]);
  assert.equal(v.ok, false);
  assert.match(v.note, /thiếu nhiều hơn/);
});

test("judge: không có mốc / không đếm được mà lệch → LỆCH; bản khôi phục nhiều hơn nguồn → LỆCH", () => {
  assert.equal(judge([{ table: "public.x", source: 5, restored: 4, late: null }])[0].ok, false);
  const [v] = judge([{ table: "public.x", source: 4, restored: 5, late: 0 }]);
  assert.equal(v.ok, false);
  assert.match(v.note, /NHIỀU hơn/);
});

test("judge: bảng thiếu hẳn ở bản khôi phục (restored = -1) → LỆCH", () => {
  assert.equal(judge([{ table: "public.x", source: 0, restored: -1, late: 0 }])[0].ok, false);
});
