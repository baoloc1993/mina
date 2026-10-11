// @vitest-environment happy-dom
// TipTap + Yjs trong DOM: mở note (rỗng hoặc có sẵn) KHÔNG được ghi gì; gõ / định dạng sinh đúng cấu trúc ProseMirror mà
// extractText đọc lại được; hai trình soạn dùng chung một tài liệu thấy nhau.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { describe, expect, test } from 'vitest';
import { docFromPlain, extractText } from '../src/crdt/doc';

function makeEditor(doc: Y.Doc) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ history: false, heading: { levels: [2] }, blockquote: false, code: false, codeBlock: false, strike: false, horizontalRule: false }),
      TaskList,
      TaskItem.configure({ nested: false }),
      Collaboration.configure({ document: doc, field: 'default' }),
    ],
  });
}

function countUpdates(doc: Y.Doc, fn: () => void): number {
  let n = 0;
  const h = (_u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') n++;
  };
  doc.on('update', h);
  fn();
  doc.off('update', h);
  return n;
}

describe('TipTap + Yjs', () => {
  test('mở note rỗng không sinh update cục bộ (không ghi note_blocks khi chỉ mở)', () => {
    const doc = new Y.Doc();
    let ed: Editor | undefined;
    const n = countUpdates(doc, () => {
      ed = makeEditor(doc);
    });
    expect(n).toBe(0);
    ed!.destroy();
  });

  test('mở note có sẵn nội dung cũng không sinh update', () => {
    const doc = docFromPlain('Dòng 1\nDòng 2');
    let ed: Editor | undefined;
    const n = countUpdates(doc, () => {
      ed = makeEditor(doc);
    });
    expect(n).toBe(0);
    expect(ed!.getText()).toContain('Dòng 1');
    ed!.destroy();
  });

  test('gõ chữ, đậm, tiêu đề, danh sách, checklist → extractText đọc lại đủ', () => {
    const doc = new Y.Doc();
    const ed = makeEditor(doc);
    ed.commands.setContent('<p>Chào <strong>bạn</strong></p>');
    ed.commands.insertContentAt(ed.state.doc.content.size, '<h2>Việc cần làm</h2><ul><li><p>Mua sữa</p></li></ul>');
    ed.commands.insertContentAt(ed.state.doc.content.size, '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Gọi thợ</p></li></ul>');
    const t = extractText(doc);
    expect(t).toContain('Chào bạn');
    expect(t).toContain('Việc cần làm');
    expect(t).toContain('Mua sữa');
    expect(t).toContain('Gọi thợ');
    ed.destroy();
  });

  test('hai trình soạn dùng chung tài liệu thấy chữ của nhau; update từ xa không bị tính là sửa cục bộ', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ea = makeEditor(a);
    const eb = makeEditor(b);
    a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'));
    ea.commands.setContent('<p>từ máy A</p>');
    expect(eb.getText()).toContain('từ máy A');
    const n = countUpdates(b, () => Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote'));
    expect(n).toBe(0);
    ea.destroy();
    eb.destroy();
  });
});

describe('Checklist bền khi sửa tiếp (dogfood newbie #4)', () => {
  test('tick, chọn một từ, đậm, gõ thêm → dòng vẫn là taskItem và còn trạng thái tick', () => {
    const doc = new Y.Doc();
    const ed = makeEditor(doc);
    ed.commands.setContent('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>mua sua</p></li></ul>');
    // chọn chữ "sua" (vị trí trong taskItem > paragraph) rồi đậm và gõ thêm
    const text = ed.state.doc.textContent;
    const from = ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n').indexOf('sua');
    expect(text).toBe('mua sua');
    ed.commands.setTextSelection({ from: 4 + from, to: 4 + from + 3 });
    ed.commands.toggleBold();
    ed.commands.setTextSelection(ed.state.doc.content.size - 2);
    ed.commands.insertContent(' NHO');
    const json = JSON.stringify(ed.getJSON());
    expect(json).toContain('"taskList"');
    expect(json).toContain('"checked":true');
    expect(extractText(doc)).toBe('mua sua NHO');
    ed.destroy();
  });
});
