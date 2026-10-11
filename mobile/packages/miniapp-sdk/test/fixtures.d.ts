// Kiểu cho script fixtures/make-clone.mjs (JS thuần) khi test import.
declare module '*/make-clone.mjs' {
  export function defaultPrefix(id: string): string;
  export function detectPrefix(manifest: { id: string; tables?: string[] }, sqls: string[]): string;
  export function makeClone(
    srcDir: string,
    newId: string,
    newName: string,
    destDir: string,
  ): { oldPrefix: string; newPrefix: string; destDir: string; manifest: Record<string, unknown> };
}
