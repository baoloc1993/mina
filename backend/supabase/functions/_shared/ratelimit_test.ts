import { assertEquals } from "jsr:@std/assert@1";
import { checkRate, DEFAULT_MAX, maxFor, type RateStore, rateKey, rateLimitedResponse } from "./ratelimit.ts";

Deno.test("maxFor: mặc định 120/30/30, nhận env hợp lệ, bỏ giá trị sai", () => {
  assertEquals([maxFor("upload", undefined), maxFor("issue-app-token", ""), maxFor("catalog", "abc")], [120, 30, 30]);
  assertEquals([maxFor("catalog", "5"), maxFor("catalog", "0"), maxFor("catalog", "-3"), maxFor("catalog", "2.5"), maxFor("catalog", "999999")], [5, 30, 30, 30, 30]);
  assertEquals(DEFAULT_MAX, { upload: 120, "issue-app-token": 30, catalog: 30 });
});

Deno.test("rateKey: tách theo function và user", () => {
  assertEquals(rateKey("catalog", "u1"), "catalog:u1");
  assertEquals(rateKey("upload", "u1") === rateKey("catalog", "u1"), false);
});

// Store giả lập cửa sổ cố định như hàm SQL.
function fakeStore(): RateStore & { calls: string[] } {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  return {
    calls,
    hit(key, _w, max) {
      calls.push(key);
      const c = (counts.get(key) ?? 0) + 1;
      counts.set(key, c);
      return Promise.resolve({ allowed: c <= max, retryAfterS: 42 });
    },
  };
}

Deno.test("checkRate: qua tới trần, chặn từ lần kế, user khác độc lập", async () => {
  const s = fakeStore();
  const r = [];
  for (let i = 0; i < 4; i++) r.push((await checkRate(s, "catalog", "u1", 3)).allowed);
  assertEquals(r, [true, true, true, false]);
  assertEquals((await checkRate(s, "catalog", "u2", 3)).allowed, true);
  assertEquals((await checkRate(s, "catalog", "u1", 3)).retryAfterS, 42);
});

Deno.test("checkRate: lỗi store → cho qua (fail-open), không ném", async () => {
  const bad: RateStore = { hit: () => Promise.reject(new Error("db chết")) };
  assertEquals(await checkRate(bad, "upload", "u1", 1), { allowed: true, retryAfterS: 0 });
});

Deno.test("checkRate: không có userId → không đếm", async () => {
  const s = fakeStore();
  assertEquals((await checkRate(s, "upload", "", 1)).allowed, true);
  assertEquals(s.calls.length, 0);
});

Deno.test("rateLimitedResponse: 429 + Retry-After + khuôn { error, retry_after_s }", async () => {
  const res = rateLimitedResponse(17);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "17");
  assertEquals(await res.json(), { error: "RATE_LIMITED", retry_after_s: 17 });
});
