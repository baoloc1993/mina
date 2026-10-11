// api-upload v1 — logic thuần (không DB, không mạng) để `deno test` chạy được.
// LWW theo trường = thứ tự tới server: áp từng thay đổi theo thứ tự nhận, PATCH chỉ chạm cột có trong `data`.
// Xoá thắng sửa: dòng đã có `deleted_at` thì PATCH/PUT tới sau trả IGNORED/DELETED, client không hồi sinh được.

export type Op = { op: string; table: string; id: string; data?: unknown };
export type Status = "ACCEPTED" | "IGNORED" | "REJECTED";
export type Result = { id: string; ok: boolean; status: Status; code?: string; error?: string };

export type StoreError = { error: { code?: string; message: string } };
export type PatchOutcome = "updated" | "deleted" | "missing";
export type Rejection = { table_name: string; row_id: string | null; op: string; data: unknown; code: string; detail?: string };

/** Lớp mỏng quanh Postgres (RLS áp bằng JWT người gọi). Lỗi hạ tầng thì `throw`, lỗi dữ liệu trả StoreError. */
export interface Store {
  allowedTables(): Promise<Set<string>>;
  /** Cập nhật dòng chưa xoá; rỗng `data` + không `deletedAt` = chỉ dò trạng thái. */
  patch(table: string, id: string, data: Record<string, unknown>, deletedAt?: string): Promise<PatchOutcome | StoreError>;
  insert(table: string, row: Record<string, unknown>): Promise<null | StoreError>;
  reject(rec: Rejection): Promise<void>;
  /** Gọi một lần cuối lô: ghi gộp các `reject` đã gom (1 INSERT thay vì N — lô lớn không đụng giới hạn CPU). */
  flush?(): Promise<void>;
}

const SYSTEM_COLUMNS = new Set(["id", "tenant_id", "created_at", "updated_at", "deleted_at"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMN = /^[a-z_][a-z0-9_]*$/;
export const MAX_OPS = 100; // ~9 ms/thay đổi: 500 song song vượt giới hạn CPU của edge runtime (dogfood đợt 2)

export function classifyDbError(e: { code?: string; message: string }): string | null {
  const c = e.code ?? "";
  if (c === "42501") return "FORBIDDEN";
  if (c === "PGRST204" || c === "42703") return "SCHEMA";
  if (c === "42P01" || c === "PGRST205") return "TABLE_NOT_ALLOWED";
  if (c.startsWith("23") || c.startsWith("22")) return "SCHEMA";
  return null; // lỗi hạ tầng — để người gọi ném, cả lô trả 500 và engine gửi lại (idempotent)
}

type Split = { cols: Record<string, unknown>; wantsDelete: boolean } | { bad: string };

/** Bỏ cột hệ thống từ client. `deleted_at` khác null = đề nghị xoá mềm (bridge viết DELETE thành UPDATE deleted_at); null thì bỏ. */
export function splitData(data: unknown): Split {
  if (data === undefined || data === null) return { cols: {}, wantsDelete: false };
  if (typeof data !== "object" || Array.isArray(data)) return { bad: "data phải là object" };
  const cols: Record<string, unknown> = {};
  let wantsDelete = false;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (k === "deleted_at") {
      if (v !== null && v !== undefined) wantsDelete = true;
      continue;
    }
    if (SYSTEM_COLUMNS.has(k)) continue;
    if (!COLUMN.test(k)) return { bad: `tên cột không hợp lệ: ${k}` };
    cols[k] = v;
  }
  return { cols, wantsDelete };
}

export async function processOps(
  ops: Op[],
  tenantId: string,
  store: Store,
  now: () => string = () => new Date().toISOString(),
): Promise<Result[]> {
  const allowed = await store.allowedTables();
  const results: Result[] = [];

  const accepted = (id: string): Result => ({ id, ok: true, status: "ACCEPTED" });
  const ignored = (id: string, code: string): Result => ({ id, ok: true, status: "IGNORED", code });
  const rejected = async (op: Op, code: string, detail?: string): Promise<Result> => {
    await store.reject({
      table_name: String(op?.table ?? ""),
      row_id: typeof op?.id === "string" ? op.id : null,
      op: String(op?.op ?? ""),
      data: op?.data ?? null,
      code,
      detail,
    });
    return { id: String(op?.id ?? ""), ok: false, status: "REJECTED", code, error: code };
  };

  for (const op of ops) {
    if (!op || typeof op !== "object") {
      results.push(await rejected(op as Op, "BAD_OP", "thay đổi không phải object"));
      continue;
    }
    if (!["PUT", "PATCH", "DELETE"].includes(op.op) || typeof op.table !== "string" || typeof op.id !== "string" || !UUID.test(op.id)) {
      results.push(await rejected(op, "BAD_OP", "cần op ∈ PUT|PATCH|DELETE, table, id UUID"));
      continue;
    }
    if (!allowed.has(op.table)) {
      results.push(await rejected(op, "TABLE_NOT_ALLOWED"));
      continue;
    }
    const split = splitData(op.data);
    if ("bad" in split) {
      results.push(await rejected(op, "SCHEMA", split.bad));
      continue;
    }
    const { cols, wantsDelete } = split;
    const deletedAt = op.op === "DELETE" || wantsDelete ? now() : undefined;
    const id = op.id;

    // Chạy thao tác trên dòng đã có → Result, hoặc null nếu dòng không thấy (cho PUT thử chèn).
    const onExisting = async (): Promise<Result | null> => {
      const r = await store.patch(op.table, id, cols, deletedAt);
      if (typeof r !== "string") {
        const code = classifyDbError(r.error);
        if (!code) throw new Error(r.error.message);
        return await rejected(op, code, r.error.message);
      }
      if (r === "updated") return accepted(id);
      if (r === "deleted") return deletedAt ? accepted(id) : ignored(id, "DELETED"); // xoá lại = idempotent
      return null; // missing
    };

    let res = await onExisting();
    if (res === null) {
      if (op.op !== "PUT") {
        // PATCH/DELETE lên dòng không thấy: không phân biệt được "không có" với "của tenant khác" (RLS) — cố ý.
        res = await rejected(op, "FORBIDDEN", "không thấy dòng hoặc không đủ quyền");
      } else {
        const row: Record<string, unknown> = { ...cols, id, tenant_id: tenantId };
        if (deletedAt) row.deleted_at = deletedAt;
        const err = await store.insert(op.table, row);
        if (err === null) {
          res = accepted(id);
        } else if (err.error.code === "23505") {
          // Trùng khoá: đua với PUT khác cùng id, hoặc id thuộc tenant khác → thử lại như PATCH.
          res = (await onExisting()) ?? (await rejected(op, "FORBIDDEN", "không thấy dòng hoặc không đủ quyền"));
        } else {
          const code = classifyDbError(err.error);
          if (!code) throw new Error(err.error.message);
          res = await rejected(op, code, err.error.message);
        }
      }
    }
    results.push(res);
  }
  await store.flush?.();
  return results;
}
