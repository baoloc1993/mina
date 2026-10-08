// Bảng `type@version → app nhận` dựng từ manifest `intents.receives` của app ĐÃ CÀI TRÊN MÁY NÀY (AC-6). THUẦN TS.
import type { ReceiverInfo } from '../bridge/types';
import type { AppRow } from '../packages/types';

export function receiversOf(apps: AppRow[], type: string, version: string | null): ReceiverInfo[] {
  return [...apps]
    .filter((a) => a.status !== 'revoked')
    .sort((a, b) => a.installed_at.localeCompare(b.installed_at)) // nhiều app nhận: chọn app cài trước (hỏi + nhớ ở vòng 8)
    .flatMap((a) =>
      (a.manifest.intents?.receives ?? [])
        .filter((r) => r.type === type && (version === null || r.version === version))
        .map((r) => ({ appId: a.app_id, type: r.type, version: r.version, schema: r.schema })),
    );
}
