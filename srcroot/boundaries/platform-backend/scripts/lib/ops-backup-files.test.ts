import assert from "node:assert/strict";
import { test } from "node:test";
import { needsFetch, safeObjectPath } from "../ops-backup-files.ts";

test("needsFetch: chưa có hoặc đổi kích thước → tải; giống → giữ", () => {
  assert.equal(needsFetch(undefined, 10), true);
  assert.equal(needsFetch({ path: "a/b", size: 10, sha256: "x", fetched_at: "t" }, 10), false);
  assert.equal(needsFetch({ path: "a/b", size: 10, sha256: "x", fetched_at: "t" }, 11), true);
});

test("safeObjectPath: chỉ <uuid>/<tên an toàn>, không thoát thư mục", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(safeObjectPath(`${id}/anh-1.png`), true);
  assert.equal(safeObjectPath(`${id}/../x`), false);
  assert.equal(safeObjectPath(`../${id}/x`), false);
  assert.equal(safeObjectPath(`${id}/a/b`), false);
  assert.equal(safeObjectPath(`${id}/`), false);
  assert.equal(safeObjectPath(`khong-phai-uuid/x.png`), false);
});
