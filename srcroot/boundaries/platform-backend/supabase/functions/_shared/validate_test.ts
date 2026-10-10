import { assertEquals } from "jsr:@std/assert@1";
import { asObject, clipRejectionData, MAX_UPLOAD_BYTES, parseAppId } from "./validate.ts";

Deno.test("parseAppId: chỉ nhận chuỗi reverse-domain; mảng/số/null/object/quá dài → null", () => {
  assertEquals(parseAppId("vn.app.note"), "vn.app.note");
  for (const bad of [["vn.app.news"], 1, null, undefined, {}, "", "../x", "VN.app.note", "a'; drop", "x".repeat(65) + ".a", "vn.app.😀"]) assertEquals(parseAppId(bad), null);
});

Deno.test("asObject: null / mảng / số / chuỗi → null", () => {
  assertEquals(asObject({ a: 1 }), { a: 1 });
  for (const bad of [null, [], 1, "x", undefined]) assertEquals(asObject(bad), null);
});

Deno.test("clipRejectionData: nhỏ giữ nguyên, lớn bị cắt còn dấu vết; không ném với vòng tròn", () => {
  assertEquals(clipRejectionData({ a: 1 }), { a: 1 });
  assertEquals(clipRejectionData(null), null);
  const big = clipRejectionData({ name: "x".repeat(50_000) }) as { _clipped: boolean; chars: number; head: string };
  assertEquals(big._clipped, true);
  assertEquals(big.head.length, 200);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assertEquals(clipRejectionData(loop), { _clipped: true });
  assertEquals(MAX_UPLOAD_BYTES, 2_000_000);
});
