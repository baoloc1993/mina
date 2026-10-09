// Trình soạn (C23) + thanh công cụ (C17): TipTap/ProseMirror gắn vào Y.Doc của phiên bằng extension Collaboration.
// Chỉ các định dạng trong PRD: đậm, nghiêng, tiêu đề, danh sách chấm / số, checklist. History của ProseMirror TẮT — Yjs lo hoàn tác cục bộ.
import { useEffect } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Collaboration from '@tiptap/extension-collaboration';
import Placeholder from '@tiptap/extension-placeholder';
import { FRAGMENT } from '../crdt/doc';
import type { NoteSession } from '../crdt/session';

export function useNoteEditor(session: NoteSession, readOnly: boolean): Editor | null {
  const editor = useEditor(
    {
      editable: !readOnly,
      extensions: [
        StarterKit.configure({
          history: false,
          heading: { levels: [2] },
          blockquote: false,
          code: false,
          codeBlock: false,
          strike: false,
          horizontalRule: false,
        }),
        TaskList,
        TaskItem.configure({ nested: false }),
        Collaboration.configure({ document: session.doc, field: FRAGMENT }),
        Placeholder.configure({ placeholder: 'Viết gì đó…' }),
      ],
      editorProps: { attributes: { 'aria-label': 'Nội dung ghi chú', spellcheck: 'true', autocapitalize: 'sentences' } },
    },
    [session],
  );
  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);
  return editor;
}

export function EditorBody({ editor }: { editor: Editor | null }) {
  return (
    <div className="editor-wrap">
      <EditorContent editor={editor} />
    </div>
  );
}

const BUTTONS: { key: string; label: string; aria: string; run: (e: Editor) => void; active: (e: Editor) => boolean }[] = [
  { key: 'b', label: 'B', aria: 'Đậm', run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
  { key: 'i', label: 'I', aria: 'Nghiêng', run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
  { key: 'h', label: 'H', aria: 'Tiêu đề', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive('heading') },
  { key: 'ul', label: '•', aria: 'Danh sách chấm', run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
  { key: 'ol', label: '1.', aria: 'Danh sách số', run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
  { key: 'cl', label: '☐', aria: 'Checklist', run: (e) => e.chain().focus().toggleTaskList().run(), active: (e) => e.isActive('taskList') },
];

export function Toolbar({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Định dạng">
      {BUTTONS.map((b) => (
        <button
          key={b.key}
          type="button"
          aria-label={b.aria}
          aria-pressed={!!editor && b.active(editor)}
          className={editor && b.active(editor) ? 'on' : ''}
          disabled={disabled || !editor}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor && b.run(editor)}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
