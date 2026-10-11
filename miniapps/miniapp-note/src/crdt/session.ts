// Phiên soạn một ghi chú: Y.Doc ↔ bảng `note_blocks` (mỗi dòng = một update hoặc snapshot Yjs, base64).
//   - mở: áp mọi dòng chưa xoá của note vào Y.Doc;
//   - sửa cục bộ: gom các update của Y.Doc, 1 s sau lần gõ cuối (hoặc khi `suspend`) ghi MỘT dòng mới (chỉ phần chênh);
//   - sync từ máy khác: `pull()` áp các dòng mới (Yjs giao hoán + idempotent nên thứ tự/số lần áp không đổi kết quả);
//   - gộp: > 200 dòng → chèn snapshot TRƯỚC, rồi xoá mềm đúng những dòng đã áp, trong MỘT db.transaction (INSERT + DELETE … IN, ≤ 100 câu).
// ARCHITECTURE.md §6 "Hai máy cùng sửa nội dung note" / "Gộp update"; DECISIONS vòng 4.
import * as Y from 'yjs';
import { normalize, makeSnippet } from '../search/normalize';
import type { Sdk } from '../sdk';
import { b64decode, b64encode, extractText } from './doc';

export const COMPACT_THRESHOLD = 200;
const DELETE_CHUNK = 400;
const REMOTE = 'remote';

export interface SessionDeps {
  sdk: Sdk;
  newId(): string;
  /** Tiêu đề hiện tại — để `search_text` luôn gồm tiêu đề + nội dung. */
  title(): string;
}

interface BlockRow {
  id: string;
  kind: string;
  data: string;
}

export class NoteSession {
  readonly doc = new Y.Doc();
  private known = new Set<string>(); // id các dòng chưa xoá đã áp vào doc (hoặc do chính mình ghi)
  private pending: Uint8Array[] = []; // update cục bộ chưa ghi
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private flushedListeners = new Set<(ok: boolean, err?: unknown) => void>();
  private dead = false;

  private constructor(
    private readonly deps: SessionDeps,
    readonly noteId: string,
  ) {
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || this.dead) return;
      this.pending.push(u);
      this.listeners.forEach((l) => l());
      this.schedule();
    });
  }

  static async open(deps: SessionDeps, noteId: string): Promise<NoteSession> {
    const s = new NoteSession(deps, noteId);
    await s.pull();
    return s;
  }

  /** Gọi khi có thay đổi cục bộ chưa ghi (để UI hiện "Đang lưu…"). */
  onLocalChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Gọi sau mỗi lần ghi (kể cả tự động sau 1 s): `ok=false` kèm lỗi khi ghi thất bại (vd READ_ONLY) — chữ vẫn giữ để ghi lại. */
  onFlushed(cb: (ok: boolean, err?: unknown) => void): () => void {
    this.flushedListeners.add(cb);
    return () => this.flushedListeners.delete(cb);
  }

  get dirty(): boolean {
    return this.pending.length > 0;
  }

  text(): string {
    return extractText(this.doc);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => undefined), 1000);
  }

  /** Áp các dòng `note_blocks` chưa áp (từ máy khác). Trả số dòng mới áp. */
  pull(): Promise<number> {
    return this.run(async () => {
      const rows = (await this.deps.sdk.db.query<BlockRow>(
        'SELECT id, kind, data FROM note_blocks WHERE note_id = ? ORDER BY created_at, id',
        [this.noteId],
      )) as BlockRow[];
      const live = new Set(rows.map((r) => r.id));
      let applied = 0;
      this.doc.transact(() => {
        for (const r of rows) {
          if (this.known.has(r.id)) continue;
          Y.applyUpdate(this.doc, b64decode(r.data), REMOTE);
          this.known.add(r.id);
          applied++;
        }
      }, REMOTE);
      for (const id of [...this.known]) if (!live.has(id)) this.known.delete(id); // đã bị gộp ở máy khác
      return applied;
    });
  }

  /** Ghi phần chênh cục bộ thành MỘT dòng `note_blocks` + cập nhật `search_text`/`snippet` của note (cùng một transaction). */
  flush(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.run(async () => {
      if (!this.pending.length) return false;
      const batch = this.pending;
      this.pending = [];
      const update = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
      const id = this.deps.newId();
      const text = this.text();
      try {
        await this.deps.sdk.db.transaction([
          { sql: 'INSERT INTO note_blocks (id, note_id, kind, data, size) VALUES (?, ?, ?, ?, ?)', params: [id, this.noteId, 'update', b64encode(update), update.length] },
          { sql: 'UPDATE notes SET search_text = ?, snippet = ? WHERE id = ?', params: [normalize(`${this.deps.title()} ${text}`), makeSnippet(text), this.noteId] },
        ]);
      } catch (e) {
        this.pending = [...batch, ...this.pending]; // không mất chữ: giữ lại để thử ghi lần sau (vd READ_ONLY → hết chỉ đọc)
        this.flushedListeners.forEach((l) => l(false, e));
        throw e;
      }
      this.known.add(id);
      this.flushedListeners.forEach((l) => l(true));
      return true;
    });
  }

  /** Gộp khi note có quá nhiều dòng. Trả true nếu đã gộp. */
  compactIfNeeded(threshold = COMPACT_THRESHOLD): Promise<boolean> {
    return this.run(async () => {
      const rows = (await this.deps.sdk.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM note_blocks WHERE note_id = ?', [this.noteId])) as { n: number }[];
      if (!rows.length || rows[0].n <= threshold) return false;
      if (this.pending.length) return false; // còn chữ chưa ghi — để lần sau, đừng gộp trên nền chưa ổn định
      const ids = [...this.known];
      if (ids.length <= threshold) return false;
      const id = this.deps.newId();
      const snap = Y.encodeStateAsUpdate(this.doc);
      const stmts: { sql: string; params: (string | number | null)[] }[] = [
        // (1) snapshot TRƯỚC — hàng đợi giữ thứ tự nên máy khác không bao giờ thấy "xoá" mà thiếu snapshot
        { sql: 'INSERT INTO note_blocks (id, note_id, kind, data, size) VALUES (?, ?, ?, ?, ?)', params: [id, this.noteId, 'snapshot', b64encode(snap), snap.length] },
      ];
      // (2) rồi xoá mềm đúng những dòng đã áp (bridge viết DELETE thành UPDATE deleted_at) — mỗi câu ≤ DELETE_CHUNK id
      for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        const part = ids.slice(i, i + DELETE_CHUNK);
        stmts.push({ sql: `DELETE FROM note_blocks WHERE note_id = ? AND id IN (${part.map(() => '?').join(', ')})`, params: [this.noteId, ...part] });
      }
      await this.deps.sdk.db.transaction(stmts);
      for (const old of ids) this.known.delete(old);
      this.known.add(id);
      return true;
    });
  }

  destroy(): void {
    this.dead = true;
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
    this.flushedListeners.clear();
    this.doc.destroy();
  }
}

/** Đọc văn bản của một note mà không mở phiên soạn (dựng lại `search_text`, trích đoạn tìm kiếm). */
export async function loadText(sdk: Sdk, noteId: string): Promise<string> {
  const rows = (await sdk.db.query<BlockRow>('SELECT id, kind, data FROM note_blocks WHERE note_id = ? ORDER BY created_at, id', [noteId])) as BlockRow[];
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const r of rows) Y.applyUpdate(doc, b64decode(r.data), REMOTE);
  }, REMOTE);
  const t = extractText(doc);
  doc.destroy();
  return t;
}
