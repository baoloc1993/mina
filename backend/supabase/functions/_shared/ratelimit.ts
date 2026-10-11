// Trần số lần gọi mỗi phút theo user. Logic thuần + cổng `RateStore`
// để test không cần DB; `makeRateStore` nối vào hàm SQL `hit_rate_limit()` (chỉ service role gọi được).
// Đếm TRƯỚC khi xử lý: 429 nghĩa là chưa áp gì. Lỗi hạ tầng khi đếm → CHO QUA (không chặn người dùng vì bảng đếm hỏng).
import { createClient } from "npm:@supabase/supabase-js@2";
import { json } from "./auth.ts";
import { log } from "./log.ts";

export type RateFn = "upload" | "issue-app-token" | "catalog";
export type HitResult = { allowed: boolean; retryAfterS: number };
export interface RateStore {
  hit(key: string, windowS: number, max: number): Promise<HitResult>;
}

export const WINDOW_S = 60;
export const DEFAULT_MAX: Record<RateFn, number> = { upload: 120, "issue-app-token": 30, catalog: 30 };
const ENV_NAME: Record<RateFn, string> = {
  upload: "RATE_LIMIT_UPLOAD_PER_MIN",
  "issue-app-token": "RATE_LIMIT_TOKEN_PER_MIN",
  catalog: "RATE_LIMIT_CATALOG_PER_MIN",
};

/** Trần của một function: env nếu là số nguyên dương hợp lệ, không thì mặc định. */
export function maxFor(fn: RateFn, raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : DEFAULT_MAX[fn];
}

export function rateKey(fn: RateFn, userId: string): string {
  return `${fn}:${userId}`;
}

/** `allowed` khi dưới trần hoặc khi không đếm được (fail-open + log). */
export async function checkRate(store: RateStore, fn: RateFn, userId: string, max: number, windowS = WINDOW_S): Promise<HitResult> {
  if (!userId) return { allowed: true, retryAfterS: 0 }; // không có user (JWT lạ) → đã bị authenticate() chặn trước đó
  try {
    return await store.hit(rateKey(fn, userId), windowS, max);
  } catch (e) {
    log("error", fn, "ratelimit_count_failed_fail_open", { error: e instanceof Error ? e.message : String(e) });
    return { allowed: true, retryAfterS: 0 };
  }
}

export function rateLimitedResponse(retryAfterS: number): Response {
  const res = json({ error: "RATE_LIMITED", retry_after_s: retryAfterS }, 429);
  res.headers.set("retry-after", String(retryAfterS));
  return res;
}

export function makeRateStore(): RateStore {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  return {
    async hit(key, windowS, max) {
      const { data, error } = await sb.rpc("hit_rate_limit", { p_key: key, p_window_s: windowS, p_max: max });
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : data) as { allowed: boolean; retry_after_s: number } | undefined;
      if (!row) throw new Error("hit_rate_limit trả rỗng");
      return { allowed: row.allowed, retryAfterS: row.retry_after_s };
    },
  };
}

/** Gọn cho Edge Function: trả `Response` 429 nếu vượt trần, `null` nếu được đi tiếp. */
export async function enforceRate(fn: RateFn, userId: string): Promise<Response | null> {
  const max = maxFor(fn, Deno.env.get(ENV_NAME[fn]));
  const r = await checkRate(makeRateStore(), fn, userId, max);
  return r.allowed ? null : rateLimitedResponse(r.retryAfterS);
}
