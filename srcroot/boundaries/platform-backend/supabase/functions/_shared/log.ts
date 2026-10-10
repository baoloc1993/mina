// Log có cấu trúc cho Edge Functions (vòng 7, PRODUCTION-READY nhóm 1): mỗi dòng là MỘT object JSON
// { ts, level, fn, event, rid, … } — lọc được trong Supabase Dashboard → Logs, lần lại một request bằng `rid` (cũng trả ở header
// `x-request-id`). KHÔNG bao giờ ghi token / khoá / mật khẩu / header Authorization / nội dung dữ liệu người dùng.
export type Level = "info" | "warn" | "error";

const SECRET_KEY = /token|authorization|password|secret|apikey|api_key|bearer|cookie|jwt|key$/i;
const MAX_STR = 300;

/** Thuần: bỏ trường nhạy cảm, cắt chuỗi dài, không ném với giá trị lạ. */
export function sanitize(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (SECRET_KEY.test(k)) {
      out[k] = "[ẩn]";
    } else if (typeof v === "string") {
      out[k] = v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…` : v;
    } else if (v instanceof Error) {
      out[k] = v.message.slice(0, MAX_STR);
    } else if (v === null || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      try {
        const s = JSON.stringify(v);
        out[k] = s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…` : JSON.parse(s);
      } catch {
        out[k] = "[không ghi được]";
      }
    }
  }
  return out;
}

export function logLine(level: Level, fn: string, event: string, fields?: Record<string, unknown>, rid?: string, now = new Date()): string {
  return JSON.stringify({ ts: now.toISOString(), level, fn, event, ...(rid ? { rid } : {}), ...sanitize(fields) });
}

export function log(level: Level, fn: string, event: string, fields?: Record<string, unknown>, rid?: string): void {
  const line = logLine(level, fn, event, fields, rid);
  if (level === "error") console.error(line);
  else console.log(line);
}

export function requestId(req: Request): string {
  const h = req.headers.get("x-request-id") ?? "";
  return /^[A-Za-z0-9._-]{8,64}$/.test(h) ? h : crypto.randomUUID();
}

/**
 * Bọc Deno.serve: sinh `rid`, đo thời gian, ghi MỘT dòng `request` (method, status, ms), bắt ngoại lệ chưa xử → 500 JSON + dòng error,
 * trả `x-request-id`. Handler nhận `rid` để gắn vào log của chính nó.
 */
export function serveLogged(fn: string, handler: (req: Request, rid: string) => Promise<Response> | Response): void {
  Deno.serve(async (req) => {
    const rid = requestId(req);
    const t0 = performance.now();
    let res: Response;
    try {
      res = await handler(req, rid);
    } catch (e) {
      log("error", fn, "unhandled", { error: e instanceof Error ? e.message : String(e) }, rid);
      res = new Response(JSON.stringify({ error: "INTERNAL" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    const ms = Math.round(performance.now() - t0);
    log(res.status >= 500 ? "error" : "info", fn, "request", { method: req.method, status: res.status, ms }, rid);
    try {
      res.headers.set("x-request-id", rid);
    } catch { /* Response bất biến (hiếm): bỏ qua */ }
    return res;
  });
}
