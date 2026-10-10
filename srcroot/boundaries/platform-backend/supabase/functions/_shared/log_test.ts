import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { logLine, requestId, sanitize } from "./log.ts";

Deno.test("logLine: JSON một dòng có ts/level/fn/event/rid", () => {
  const line = logLine("info", "catalog", "request", { status: 200, ms: 12 }, "rid-12345678", new Date("2026-10-10T00:00:00Z"));
  assert(!line.includes("\n"));
  assertEquals(JSON.parse(line), { ts: "2026-10-10T00:00:00.000Z", level: "info", fn: "catalog", event: "request", rid: "rid-12345678", status: 200, ms: 12 });
});

Deno.test("sanitize: ẩn trường nhạy cảm theo tên, cắt chuỗi dài, nhận Error / object / giá trị lạ", () => {
  const out = sanitize({
    token: "eyJabc", authorization: "Bearer x", SUPABASE_SERVICE_ROLE_KEY: "k", password: "p", apiKey: "a", jwt: "j",
    detail: "x".repeat(1000), err: new Error("hỏng"), n: 3, ok: true, nil: null, obj: { a: 1 },
  });
  for (const k of ["token", "authorization", "SUPABASE_SERVICE_ROLE_KEY", "password", "apiKey", "jwt"]) assertEquals(out[k], "[ẩn]");
  assertEquals((out.detail as string).length, 301);
  assertEquals(out.err, "hỏng");
  assertEquals([out.n, out.ok, out.nil, out.obj], [3, true, null, { a: 1 }]);
});

Deno.test("sanitize: vòng tròn / BigInt không làm ném", () => {
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assertEquals(sanitize({ loop }).loop, "[không ghi được]");
  assertEquals(sanitize({ big: 10n as unknown }).big, "[không ghi được]");
});

Deno.test("logLine không bao giờ chứa giá trị bí mật dù đặt ở trường tên nhạy cảm", () => {
  const line = logLine("error", "upload", "x", { token: "SECRET-VALUE-123", authorization: "Bearer SECRET-VALUE-123" });
  assert(!line.includes("SECRET-VALUE-123"));
});

Deno.test("requestId: nhận x-request-id hợp lệ, còn lại sinh UUID", () => {
  const ok = new Request("http://x/", { headers: { "x-request-id": "abc-12345678" } });
  assertEquals(requestId(ok), "abc-12345678");
  for (const bad of ["", "short", "x".repeat(65), "has space and <script>"]) {
    const id = requestId(new Request("http://x/", { headers: bad ? { "x-request-id": bad } : {} }));
    assertMatch(id, /^[0-9a-f-]{36}$/);
  }
});
