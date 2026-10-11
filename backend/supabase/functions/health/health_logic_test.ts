import { assertEquals } from "jsr:@std/assert@1";
import { healthBody } from "./health_logic.ts";

Deno.test("healthBody: DB sống → 200 ok; DB chết → 503", () => {
  assertEquals(healthBody(true, "abc1234"), { status: 200, body: { ok: true, db: true, version: "abc1234" } });
  assertEquals(healthBody(false, "abc1234"), { status: 503, body: { ok: false, db: false, version: "abc1234" } });
});

Deno.test("healthBody: version thiếu / lạ → 'dev', không lộ chuỗi tuỳ ý", () => {
  assertEquals(healthBody(true, undefined).body.version, "dev");
  assertEquals(healthBody(true, "").body.version, "dev");
  assertEquals(healthBody(true, "<script>x</script>").body.version, "dev");
  assertEquals(healthBody(true, "x".repeat(41)).body.version, "dev");
});
