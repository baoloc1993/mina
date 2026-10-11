// Tài liệu Yjs của một ghi chú. Nội dung nằm ở XmlFragment `default` — đúng trường mà extension Collaboration của TipTap đọc/ghi,
// với tên node của StarterKit (paragraph, heading, bulletList, orderedList, listItem) + TaskList (taskList, taskItem).
import * as Y from 'yjs';

export const FRAGMENT = 'default';

export function b64encode(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const textOf = (children: unknown[]): string =>
  children
    .map((c) => {
      if (c instanceof Y.XmlText) {
        return (c.toDelta() as { insert?: unknown }[]).map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('');
      }
      if (c instanceof Y.XmlElement && c.nodeName === 'hardBreak') return '\n';
      return '';
    })
    .join('');

function walk(node: Y.XmlElement | Y.XmlFragment, out: string[]): void {
  const kids = node.toArray();
  if (kids.some((k) => k instanceof Y.XmlText)) {
    out.push(textOf(kids));
    return;
  }
  for (const k of kids) {
    if (k instanceof Y.XmlElement) {
      // Khối lá rỗng (đoạn trống) cũng là một dòng; khối chứa khối khác thì đi sâu.
      if (k.length === 0) out.push('');
      else walk(k, out);
    }
  }
}

/** Văn bản thuần của ghi chú: mỗi khối (đoạn, tiêu đề, mục danh sách, mục checklist) một dòng. NFC để dấu tiếng Việt nhất quán. */
export function extractText(doc: Y.Doc): string {
  const out: string[] = [];
  walk(doc.getXmlFragment(FRAGMENT), out);
  return out.join('\n').normalize('NFC');
}

/** Dựng tài liệu từ văn bản thường (intent `note.create`): mỗi dòng một đoạn; có `url` thì thêm một đoạn cuối. */
export function docFromPlain(body: string, url?: string | null): Y.Doc {
  const doc = new Y.Doc();
  const lines = body.split(/\r?\n/);
  if (url) lines.push(url);
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  doc.transact(() => {
    const frag = doc.getXmlFragment(FRAGMENT);
    for (const line of lines) {
      const p = new Y.XmlElement('paragraph');
      frag.push([p]);
      if (line) {
        const t = new Y.XmlText();
        p.push([t]);
        t.insert(0, line.normalize('NFC'));
      }
    }
  });
  return doc;
}

/** Update rỗng của Yjs (không struct, không xoá) dài 2 byte. */
export function isEmptyUpdate(u: Uint8Array): boolean {
  return u.length <= 2;
}

/** Áp một dãy update (base64) vào tài liệu mới. */
export function docFromUpdates(updates: string[]): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const u of updates) Y.applyUpdate(doc, b64decode(u), 'remote');
  }, 'remote');
  return doc;
}
