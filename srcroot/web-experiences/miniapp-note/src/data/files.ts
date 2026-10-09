// Đính kèm: ảnh (`ui.pickImage`) và PDF (`ui.pickFile`, SDK 0.1.1). File đã ở `core_files` + Storage nhờ SDK; Ghi chú chỉ ghi liên kết
// `note_files`. Gỡ đính kèm = xoá mềm liên kết (file giữ lại — dọn Storage ở vòng 7).
import { newId, type Sdk } from '../sdk';

export const PDF_MIME = 'application/pdf';

export interface AttachmentRow {
  id: string;
  note_id: string;
  file_id: string;
  kind: 'image' | 'pdf';
  name: string | null;
  mime: string | null;
  size: number | null;
}

export async function listAttachments(sdk: Sdk, noteId: string): Promise<AttachmentRow[]> {
  return (await sdk.db.query<AttachmentRow>('SELECT id, note_id, file_id, kind, name, mime, size FROM note_files WHERE note_id = ? ORDER BY created_at, id', [noteId])) as AttachmentRow[];
}

const imageName = (uri: string, i: number) => decodeURIComponent(uri.split('/').pop() ?? '') || `Ảnh ${i + 1}`;

/** Chọn ảnh từ thư viện rồi đính vào note. Huỷ chọn → []. Lỗi `PERMISSION_DENIED` / `READ_ONLY` do SDK ném — để nơi gọi hiện câu rõ. */
export async function attachImages(sdk: Sdk, noteId: string): Promise<AttachmentRow[]> {
  const { files } = await sdk.ui.pickImage({ multiple: true });
  const rows: AttachmentRow[] = files.map((f, i) => ({ id: newId(), note_id: noteId, file_id: f.fileId, kind: 'image', name: imageName(f.uri, i), mime: f.mime, size: null }));
  await link(sdk, rows);
  return rows;
}

/** Chọn PDF rồi đính vào note. Sai loại / > 50 MB → SDK ném `INVALID_REQUEST` (không lưu gì). */
export async function attachPdfs(sdk: Sdk, noteId: string): Promise<AttachmentRow[]> {
  const { files } = await sdk.ui.pickFile({ mime: [PDF_MIME], multiple: true });
  const rows: AttachmentRow[] = files.map((f) => ({ id: newId(), note_id: noteId, file_id: f.fileId, kind: 'pdf', name: f.name, mime: f.mime, size: f.size }));
  await link(sdk, rows);
  return rows;
}

async function link(sdk: Sdk, rows: AttachmentRow[]): Promise<void> {
  if (!rows.length) return;
  await sdk.db.transaction(
    rows.map((r) => ({
      sql: 'INSERT INTO note_files (id, note_id, file_id, kind, name, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [r.id, r.note_id, r.file_id, r.kind, r.name, r.mime, r.size],
    })),
  );
}

export async function detachAttachment(sdk: Sdk, id: string): Promise<void> {
  await sdk.db.execute('DELETE FROM note_files WHERE id = ?', [id]);
}

/** URI cục bộ để hiện thumbnail; null khi file chưa về máy này (chưa upload từ máy khác → NOT_FOUND). */
export async function fileUri(sdk: Sdk, fileId: string): Promise<{ uri: string; status: string } | null> {
  try {
    return await sdk.storage.get(fileId);
  } catch {
    return null;
  }
}

export const humanSize = (n: number | null): string => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
};
