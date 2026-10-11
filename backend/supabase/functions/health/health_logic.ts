// `health` (vòng 7): trạng thái công khai tối thiểu — chỉ 3 trường, không lộ dữ liệu hay cấu hình.
export type Health = { ok: boolean; db: boolean; version: string };

export function healthBody(dbOk: boolean, version: string | undefined): { status: number; body: Health } {
  const v = /^[0-9a-zA-Z._-]{1,40}$/.test(version ?? "") ? (version as string) : "dev";
  return { status: dbOk ? 200 : 503, body: { ok: dbOk, db: dbOk, version: v } };
}
