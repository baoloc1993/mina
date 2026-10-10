// Kiểm khôi phục backup (vòng 7, AC-2): so SỐ DÒNG từng bảng giữa DB nguồn và DB đã khôi phục.
//   npm run ops:verify-restore -- --source <DATABASE_URL> --restored <DATABASE_URL> [--backup-at <ISO>]
// Bảng so: mọi bảng `public` (trừ rate_limits — dữ liệu tạm), `auth.users`, `storage.objects`.
// Lệch chỉ được là dòng ghi SAU giờ backup: cần --backup-at; script đếm dòng nguồn có created_at/updated_at > mốc đó
// và chỉ chấp nhận khi `nguồn − dòng sau mốc = khôi phục`. Không in chuỗi kết nối (có mật khẩu).
import pg from "pg";

export type TableCount = { table: string; source: number; restored: number; late: number | null };
export type Verdict = { table: string; source: number; restored: number; late: number; ok: boolean; note: string };

/** Thuần: phán từng bảng. `late` null = không đếm được dòng sau mốc (bảng không có cột thời gian / không đưa mốc). */
export function judge(rows: TableCount[]): Verdict[] {
  return rows.map((r) => {
    if (r.source === r.restored) return { table: r.table, source: r.source, restored: r.restored, late: r.late ?? 0, ok: true, note: "khớp" };
    if (r.late !== null && r.source - r.late === r.restored) {
      return { table: r.table, source: r.source, restored: r.restored, late: r.late, ok: true, note: `${r.late} dòng ghi sau giờ backup` };
    }
    return {
      table: r.table, source: r.source, restored: r.restored, late: r.late ?? 0, ok: false,
      note: r.restored > r.source ? "bản khôi phục NHIỀU hơn nguồn" : r.late === null ? "thiếu dòng, không giải thích được (không có mốc / cột thời gian)" : "thiếu nhiều hơn số dòng ghi sau backup",
    };
  });
}

async function countsOf(db: pg.Client, tables: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const t of tables) m.set(t, Number((await db.query(`select count(*) as n from ${t}`)).rows[0].n));
  return m;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const source = flag("--source"), restored = flag("--restored"), backupAt = flag("--backup-at");
  if (!source || !restored) { console.error("dùng: npm run ops:verify-restore -- --source <url> --restored <url> [--backup-at <ISO>]"); process.exit(2); }
  if (source === restored) { console.error("--source và --restored phải khác nhau"); process.exit(2); }
  if (backupAt && Number.isNaN(Date.parse(backupAt))) { console.error("--backup-at phải là ISO-8601"); process.exit(2); }
  const a = new pg.Client({ connectionString: source });
  const b = new pg.Client({ connectionString: restored });
  await a.connect();
  await b.connect();
  try {
    const list = (await a.query(
      `select format('%I.%I', schemaname, tablename) as t from pg_tables
        where (schemaname = 'public' and tablename <> 'rate_limits') or (schemaname, tablename) in (('auth','users'), ('storage','objects'))
        order by 1`)).rows.map((r) => r.t as string);
    const src = await countsOf(a, list);
    const dstTables = new Set((await b.query(
      `select format('%I.%I', schemaname, tablename) as t from pg_tables where schemaname in ('public','auth','storage')`)).rows.map((r) => r.t as string));
    const rows: TableCount[] = [];
    for (const t of list) {
      const restoredN = dstTables.has(t) ? Number((await b.query(`select count(*) as n from ${t}`)).rows[0].n) : -1;
      let late: number | null = null;
      if (backupAt) {
        const cols = (await a.query(
          `select column_name from information_schema.columns where table_schema || '.' || table_name = $1 and column_name in ('created_at','updated_at')`,
          [t.replace(/"/g, "")])).rows.map((r) => r.column_name as string);
        if (cols.length) {
          const cond = cols.map((c) => `${c} > $1`).join(" or ");
          late = Number((await a.query(`select count(*) as n from ${t} where ${cond}`, [backupAt])).rows[0].n);
        } else late = 0 === src.get(t)! ? 0 : null;
      }
      rows.push({ table: t, source: src.get(t)!, restored: restoredN, late });
    }
    const verdicts = judge(rows);
    for (const v of verdicts) console.log(`  ${v.ok ? "✓" : "✗"} ${v.table.padEnd(46)} nguồn ${String(v.source).padStart(7)} · khôi phục ${String(v.restored).padStart(7)} · ${v.note}`);
    const bad = verdicts.filter((v) => !v.ok);
    console.log(`\n${bad.length ? "✗" : "✓"} ${verdicts.length - bad.length}/${verdicts.length} bảng khớp${bad.length ? ` — ${bad.length} bảng LỆCH, chưa được coi là khôi phục thành công` : ""}`);
    if (bad.length) process.exit(1);
  } finally {
    await a.end();
    await b.end();
  }
}

if (process.argv[1]?.endsWith("ops-verify-restore.ts")) {
  main().catch((e) => { console.error("ops:verify-restore lỗi:", e instanceof Error ? e.message : e); process.exit(1); });
}
