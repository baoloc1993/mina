import { assertEquals } from "jsr:@std/assert@1";
import { asObject, clipRejectionData, MAX_UPLOAD_BYTES, parseAppId, readTextLimited } from "./validate.ts";

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

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (i < parts.length) ctrl.enqueue(parts[i++]);
      else ctrl.close();
    },
  });
}

Deno.test("readTextLimited: đọc đủ khi dưới trần (gồm UTF-8 nhiều byte, chunked); null/rỗng", async () => {
  const enc = new TextEncoder();
  assertEquals(await readTextLimited(streamOf([enc.encode("xin "), enc.encode("chào Việt")]), 100), "xin chào Việt");
  assertEquals(await readTextLimited(null, 10), "");
  assertEquals(await readTextLimited(streamOf([]), 10), "");
});

Deno.test("readTextLimited: vượt trần BYTE → null và dừng đọc (không đọc hết body)", async () => {
  let pulled = 0;
  const big = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      pulled++;
      if (pulled > 1000) ctrl.close();
      else ctrl.enqueue(new Uint8Array(1000));
    },
  });
  assertEquals(await readTextLimited(big, 5000), null);
  assertEquals(pulled < 20, true);
  // 3 ký tự 'ệ' = 9 byte > 8 dù chỉ 3 ký tự
  assertEquals(await readTextLimited(streamOf([new TextEncoder().encode("ệệệ")]), 8), null);
});
