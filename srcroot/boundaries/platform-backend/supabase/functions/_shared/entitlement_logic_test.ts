import { assertEquals } from "jsr:@std/assert@1";
import { graceDays, isReadOnly, toEntitlement } from "./entitlement_logic.ts";

const NOW = new Date("2026-10-09T00:00:00Z");

Deno.test("graceDays: mặc định 7, đọc env hợp lệ, bỏ giá trị sai", () => {
  assertEquals([graceDays(undefined), graceDays(""), graceDays("3"), graceDays("0"), graceDays("abc"), graceDays("-1")], [7, 7, 3, 0, 7, 7]);
});

Deno.test("isReadOnly: null không bao giờ hết hạn; quá until + ân hạn mới chỉ đọc", () => {
  assertEquals(isReadOnly(null, 7, NOW), false);
  assertEquals(isReadOnly("2026-10-20T00:00:00Z", 7, NOW), false); // còn hạn
  assertEquals(isReadOnly("2026-10-05T00:00:00Z", 7, NOW), false); // hết hạn nhưng trong ân hạn
  assertEquals(isReadOnly("2026-10-02T00:00:00Z", 7, NOW), false); // đúng biên: until + 7 ngày = now
  assertEquals(isReadOnly("2026-10-01T23:59:59Z", 7, NOW), true);
  assertEquals(isReadOnly("2026-09-01T00:00:00Z", 7, NOW), true);
  assertEquals(isReadOnly("2026-10-08T00:00:00Z", 0, NOW), true); // ân hạn 0
  assertEquals(isReadOnly("không phải ngày", 7, NOW), false);
});

Deno.test("toEntitlement: đủ trường, until chuẩn ISO, max_apps null khi không giới hạn", () => {
  assertEquals(
    toEntitlement({ plan: "mvp-unlimited", entitlement_until: null }, { max_apps: null }, 7),
    { plan: "mvp-unlimited", max_apps: null, until: null, grace_days: 7 },
  );
  assertEquals(
    toEntitlement({ plan: "p", entitlement_until: "2026-09-01T00:00:00+00:00" }, { max_apps: 3 }, 5),
    { plan: "p", max_apps: 3, until: "2026-09-01T00:00:00.000Z", grace_days: 5 },
  );
});
