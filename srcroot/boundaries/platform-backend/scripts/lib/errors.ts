// Mã lỗi CLI = mã lỗi hợp đồng `api-registry-publish` (ARCHITECTURE §5). In tiếng Việt kèm mã.
export type RegistryCode =
  | "VERSION_NOT_GREATER" | "MIGRATION_NOT_ADDITIVE" | "TABLE_OUTSIDE_PREFIX" | "BAD_MANIFEST" | "SIGNING_KEY_MISSING"
  | "MIGRATION_CHANGED" | "KEY_MISMATCH" | "VERSION_NOT_FOUND" | "BAD_STATE" | "TENANT_NOT_FOUND" | "PLAN_NOT_FOUND"
  | "APP_OWNER_CONFLICT" | "STORAGE_ERROR" | "CONFIG_MISSING" | "MISSING_ARGS" | "UNKNOWN_COMMAND" | "KEYGEN_FAILED" | "TABLE_PREFIX_CONFLICT" | "BAD_DATE" | "BAD_CONFIG" | "APP_NOT_FOUND" | "CRON_MISSING";

export class RegistryError extends Error {
  code: RegistryCode;
  detail: string;
  constructor(code: RegistryCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}
