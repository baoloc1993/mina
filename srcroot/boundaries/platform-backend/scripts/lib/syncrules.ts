// registry gen-sync-rules — sinh powersync/sync-rules.yaml từ app_tables × installations.
// Không lọc theo giá trị client gửi: chỉ theo claim `tenant_id` đã ký trong JWT.
import type { Client } from "pg";

export type AppTables = { id: string; table_prefix: string; tables: string[] };

/** Dữ liệu dùng chung trong tenant (vòng 3): mọi tenant, không theo app đã cài. */
export const CORE_TABLES = ["core_contacts", "core_files", "core_tags"];

export function renderSyncRules(apps: AppTables[]): string {
  const lines = [
    "# FILE SINH bởi `npm run registry -- gen-sync-rules` từ app_tables × installations — KHÔNG sửa tay (sửa scripts/lib/syncrules.ts).",
    "# Mỗi app một bucket: thiết bị chỉ kéo bảng của app mà tenant đã cài và bật (installations.enabled).",
    "# Gỡ app → ngừng kéo; dữ liệu server giữ nguyên. Không bao giờ lọc theo giá trị client gửi — chỉ theo claim đã ký.",
    "bucket_definitions:",
    "  installations:",
    "    parameters: select request.jwt() ->> 'tenant_id' as tenant_id",
    "    data:",
    "      - select app_id as id, app_id, tenant_id, version, enabled, position, installed_at, updated_at from installations where tenant_id = bucket.tenant_id",
    "  rejections:",
    "    parameters: select request.jwt() ->> 'tenant_id' as tenant_id",
    "    data:",
    "      - select * from sync_rejections where tenant_id = bucket.tenant_id",
  ];
  lines.push(
    "  core:",
    "    parameters: select request.jwt() ->> 'tenant_id' as tenant_id",
    "    data:",
    ...CORE_TABLES.map((t) => `      - select * from ${t} where tenant_id = bucket.tenant_id`),
  );
  for (const app of apps) {
    lines.push(
      `  ${app.table_prefix}:`,
      `    parameters: select tenant_id from installations where tenant_id = request.jwt() ->> 'tenant_id' and app_id = '${app.id}' and enabled = true`,
      "    data:",
      ...app.tables.map((t) => `      - select * from ${t} where tenant_id = bucket.tenant_id`),
    );
  }
  return lines.join("\n") + "\n";
}

export async function loadApps(db: Client): Promise<AppTables[]> {
  const r = await db.query(
    `select a.id, a.table_prefix, array_agg(t.table_name order by t.table_name) as tables
       from public.apps a join public.app_tables t on t.app_id = a.id
      where a.id <> '_core'
      group by a.id, a.table_prefix order by a.id`,
  );
  return r.rows;
}
