// Entitlement (api-entitlement) — logic thuần dùng chung cho `catalog` và `upload`: cùng một ngưỡng ân hạn.
export const DEFAULT_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

/** Số ngày ân hạn từ env `ENTITLEMENT_GRACE_DAYS`; thiếu / sai / âm → mặc định 7. */
export function graceDays(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim() === "") return DEFAULT_GRACE_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_DAYS;
}

/** Chỉ đọc khi `until` không null và `until + grace < now`. null = không bao giờ hết hạn. */
export function isReadOnly(until: string | null | undefined, grace: number, now: Date = new Date()): boolean {
  if (!until) return false;
  const t = Date.parse(until);
  if (Number.isNaN(t)) return false; // dữ liệu hỏng không được khoá người dùng
  return t + grace * DAY_MS < now.getTime();
}

export type Entitlement = { plan: string; max_apps: number | null; until: string | null; grace_days: number };

export function toEntitlement(
  tenant: { plan: string; entitlement_until: string | null },
  plan: { max_apps: number | null } | null,
  grace: number,
): Entitlement {
  return {
    plan: tenant.plan,
    max_apps: plan?.max_apps ?? null,
    until: tenant.entitlement_until ? new Date(tenant.entitlement_until).toISOString() : null,
    grace_days: grace,
  };
}
