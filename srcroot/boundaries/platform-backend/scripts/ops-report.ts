// Báo cáo H3 (vòng 7, AC-3): số ngày P1 đã mở mini app, ngày bỏ trống, số lần mở theo app — từ bảng `app_opens_daily`.
//   npm run ops:report -- <email> [--from YYYY-MM-DD] [--days 28]        (local)
//   REGISTRY_ENV=prod npm run ops:report -- <email> --from 2026-11-01     (production, đọc deployment/prod/.env)
// Ngày tính theo giờ Việt Nam (khớp record_app_open). Không in gì ngoài số đếm.
import pg from "pg";
import { config, loadLocalEnv } from "./lib/env.ts";

export type DayRow = { day: string; opens: number; apps: string[] };

/** Thuần: từ danh sách ngày có dùng → số ngày dùng, ngày trống, chuỗi dài nhất, ngày cuối (để test không cần DB). */
export function summarize(from: string, days: number, rows: DayRow[]): {
  used: number; missing: string[]; longestStreak: number; window: string[]; verdict: string;
} {
  const start = new Date(`${from}T00:00:00Z`);
  const window: string[] = [];
  for (let i = 0; i < days; i++) window.push(new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  const usedSet = new Set(rows.filter((r) => r.opens > 0).map((r) => r.day));
  const missing = window.filter((d) => !usedSet.has(d));
  let longest = 0, cur = 0;
  for (const d of window) {
    cur = usedSet.has(d) ? cur + 1 : 0;
    longest = Math.max(longest, cur);
  }
  const used = window.length - missing.length;
  // Ngưỡng PRD §6: GO ≥ 24/28 · KILL ≤ 14/28 (cùng tỉ lệ nếu cửa sổ khác 28 ngày — chỉ phán quyết khi đủ 28).
  const verdict = days < 28 ? "chưa đủ 28 ngày — chưa phán" : used >= 24 ? "đạt ngưỡng GO về số ngày (còn phải 0 sự cố)" : used <= 14 ? "dưới ngưỡng KILL về số ngày" : "vùng PIVOT về số ngày";
  return { used, missing, longestStreak: longest, window, verdict };
}

async function main(): Promise<void> {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--from" && args[args.indexOf(a) - 1] !== "--days");
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  if (!email) { console.error("dùng: npm run ops:report -- <email> [--from YYYY-MM-DD] [--days 28]"); process.exit(2); }
  const days = Number(flag("--days") ?? 28);
  if (!Number.isInteger(days) || days < 1 || days > 366) { console.error("--days phải là số nguyên 1..366"); process.exit(2); }
  const from = flag("--from") ?? new Date(Date.now() + 7 * 3600_000 - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) { console.error("--from phải dạng YYYY-MM-DD"); process.exit(2); }

  const db = new pg.Client({ connectionString: config().databaseUrl });
  await db.connect();
  try {
    const t = await db.query("select t.id from public.tenants t join auth.users u on u.id = t.owner_user_id where u.email = $1", [email]);
    if (t.rowCount === 0) { console.error(`không có tenant cho ${email}`); process.exit(1); }
    const r = await db.query(
      `select day::text as day, sum(opens)::int as opens, array_agg(app_id order by app_id) as apps
         from public.app_opens_daily where tenant_id = $1 and day >= $2::date and day < $2::date + $3::int group by day order by day`,
      [t.rows[0].id, from, days]);
    const s = summarize(from, days, r.rows as DayRow[]);
    console.log(`H3 — ${email} · ${from} → ${s.window[s.window.length - 1]} (${days} ngày)`);
    console.log(`  ngày có dùng: ${s.used}/${days} · chuỗi liên tục dài nhất: ${s.longestStreak} ngày`);
    console.log(`  ngày bỏ trống: ${s.missing.length ? s.missing.join(", ") : "không"}`);
    console.log(`  phán quyết số ngày: ${s.verdict}`);
    const per = await db.query(
      `select app_id, sum(opens)::int as opens, count(*)::int as days from public.app_opens_daily
        where tenant_id = $1 and day >= $2::date and day < $2::date + $3::int group by app_id order by app_id`, [t.rows[0].id, from, days]);
    for (const p of per.rows) console.log(`  ${p.app_id}: ${p.opens} lần mở trong ${p.days} ngày`);
  } finally {
    await db.end();
  }
}

if (process.argv[1]?.endsWith("ops-report.ts")) {
  main().catch((e) => { console.error("ops:report lỗi:", e instanceof Error ? e.message : e); process.exit(1); });
}
