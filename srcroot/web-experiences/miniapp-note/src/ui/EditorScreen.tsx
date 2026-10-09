// S12 Soạn ghi chú: tiêu đề + trình soạn rich text (Yjs) + tag + đính kèm. Trạng thái: mới/đang gõ/đã lưu · đã hợp nhất từ máy khác ·
// thùng rác (chỉ xem + Khôi phục) · chỉ đọc · không tìm thấy (NOT_FOUND). Bám PROTOTYPE.md §1 (đã chốt 2026-10-09).
import { useCallback, useEffect, useRef, useState } from 'react';
import { NoteSession } from '../crdt/session';
import { attachImages, attachPdfs, detachAttachment, humanSize, listAttachments, fileUri, type AttachmentRow } from '../data/files';
import { getNote, restoreNote, setPinned, setTitle, trashNote, type NoteRow } from '../data/repo';
import { attachTag, detachTag, ensureTag, listTagGroups, tagsByNote, type TagGroup } from '../data/tags';
import { newId, type Sdk } from '../sdk';
import { EditorBody, Toolbar, useNoteEditor } from './Editor';
import { Banner, Empty, friendly, TagChip, type ToastState } from './kit';
import { TagSheet } from './TagSheet';

type Load = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; session: NoteSession; note: NoteRow };

export interface EditorProps {
  sdk: Sdk;
  id: string;
  readOnly: boolean;
  onBack: () => void;
  onTrashed: (id: string) => void;
  toast: (t: ToastState) => void;
  /** Phiên đang mở — để App ép lưu khi nhận `lifecycle.suspend`. */
  register: (s: NoteSession | null) => void;
}

export function EditorScreen(p: EditorProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt] = useState(0);
  const titleRef = useRef('');

  useEffect(() => {
    let alive = true;
    let opened: NoteSession | null = null;
    setLoad({ status: 'loading' });
    (async () => {
      const note = await getNote(p.sdk, p.id);
      if (!alive) return;
      if (!note) return setLoad({ status: 'missing' });
      titleRef.current = note.title;
      const session = await NoteSession.open({ sdk: p.sdk, newId, title: () => titleRef.current }, p.id);
      if (!alive) return session.destroy();
      opened = session;
      p.register(session);
      setLoad({ status: 'ready', session, note });
    })().catch(() => alive && setLoad({ status: 'missing' }));
    return () => {
      alive = false;
      if (opened) {
        p.register(null);
        void opened.flush().catch(() => undefined).finally(() => opened?.destroy());
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, p.sdk, attempt]);

  if (load.status === 'loading') {
    return (
      <div className="screen">
        <div className="bar">
          <button className="iconbtn" aria-label="Quay lại" onClick={p.onBack}>←</button>
          <h1 className="title small">Ghi chú</h1>
        </div>
        <div className="body"><div className="skel" aria-busy="true"><div /><div /></div></div>
      </div>
    );
  }
  if (load.status === 'missing') {
    return (
      <div className="screen">
        <div className="bar">
          <button className="iconbtn" aria-label="Quay lại" onClick={p.onBack}>←</button>
          <h1 className="title small">Ghi chú</h1>
        </div>
        <div className="body">
          <Empty glyph="!" tone="err" action={{ label: 'Về danh sách', run: p.onBack, secondary: true }}>
            Không tìm thấy ghi chú này (NOT_FOUND)
          </Empty>
        </div>
      </div>
    );
  }
  return <Ready key={`${p.id}:${attempt}`} {...p} session={load.session} first={load.note} titleRef={titleRef} />;
}

function Ready(p: EditorProps & { session: NoteSession; first: NoteRow; titleRef: { current: string } }) {
  const { sdk, session, titleRef } = p;
  const [note, setNote] = useState<NoteRow>(p.first);
  const [title, setTitleState] = useState(p.first.title);
  const [save, setSave] = useState<'saved' | 'saving' | 'bad'>('saved');
  const [banner, setBanner] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [groups, setGroups] = useState<TagGroup[]>([]);
  const [mine, setMine] = useState<TagGroup[]>([]);
  const [atts, setAtts] = useState<AttachmentRow[]>([]);
  const [busy, setBusy] = useState<'img' | 'pdf' | null>(null);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleFocus = useRef(false);
  const trashed = note.trashed_at_ms !== null;
  const viewOnly = p.readOnly || trashed;
  const editor = useNoteEditor(session, viewOnly);

  // lưu trạng thái ghi
  useEffect(() => {
    const off1 = session.onLocalChange(() => setSave('saving'));
    const off2 = session.onFlushed((ok) => {
      setSave(ok ? 'saved' : 'bad');
      if (ok) void session.compactIfNeeded().catch(() => undefined);
    });
    return () => (off1(), off2());
  }, [session]);

  // chữ bị từ chối lúc chỉ đọc: hết chỉ đọc thì ghi lại
  useEffect(() => {
    if (!p.readOnly && session.dirty) void session.flush().catch(() => undefined);
  }, [p.readOnly, session]);

  const refreshMeta = useCallback(async () => {
    const [g, n, a] = await Promise.all([listTagGroups(sdk), getNote(sdk, note.id), listAttachments(sdk, note.id)]);
    setGroups(g);
    setMine([...(await tagsByNote(sdk, g)).get(note.id) ?? []]);
    setAtts(a);
    if (n) {
      setNote((old) => (old.pinned === n.pinned && old.trashed_at_ms === n.trashed_at_ms && old.title === n.title ? old : n));
      if (!titleFocus.current && n.title !== titleRef.current) {
        titleRef.current = n.title;
        setTitleState(n.title);
      }
    }
  }, [sdk, note.id, titleRef]);

  // nhận thay đổi từ máy khác: áp update mới vào tài liệu đang mở + làm mới tag/đính kèm/ghim/thùng rác
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const applied = await session.pull();
        if (applied > 0 && !stop) setBanner('Đã hợp nhất thay đổi từ máy khác — chữ của cả hai máy đều còn.');
        await refreshMeta();
      } catch {
        /* lần sau thử lại */
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 3000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [session, refreshMeta]);

  const onTitle = (v: string) => {
    setTitleState(v);
    titleRef.current = v;
    if (titleTimer.current) clearTimeout(titleTimer.current);
    setSave('saving');
    titleTimer.current = setTimeout(() => {
      setTitle(sdk, note.id, v, session.text())
        .then(() => setSave(session.dirty ? 'saving' : 'saved'))
        .catch(() => setSave('bad'));
    }, 600);
  };
  useEffect(
    () => () => {
      if (titleTimer.current) {
        clearTimeout(titleTimer.current);
        void setTitle(sdk, note.id, titleRef.current, session.text()).catch(() => undefined);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const guard = async (what: 'write' | 'image' | 'file', fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      p.toast({ msg: friendly(e, what === 'file' ? 'file' : what === 'image' ? 'image' : 'write'), err: true });
    }
  };

  const onPin = () =>
    guard('write', async () => {
      setMenu(false);
      await setPinned(sdk, note.id, !note.pinned);
      await refreshMeta();
      p.toast({ msg: note.pinned ? 'Đã bỏ ghim' : 'Đã ghim lên đầu danh sách' });
    });
  const onTrash = () =>
    guard('write', async () => {
      setMenu(false);
      await session.flush().catch(() => undefined);
      await trashNote(sdk, note.id);
      p.onTrashed(note.id);
    });
  const onRestore = () =>
    guard('write', async () => {
      await restoreNote(sdk, note.id);
      setNote({ ...note, trashed_at_ms: null });
      p.toast({ msg: 'Đã khôi phục ghi chú' });
    });
  const onAddImage = () =>
    guard('image', async () => {
      setBusy('img');
      try {
        const rows = await attachImages(sdk, note.id);
        if (rows.length) await refreshMeta();
      } finally {
        setBusy(null);
      }
    });
  const onAddFile = () =>
    guard('file', async () => {
      setBusy('pdf');
      try {
        const rows = await attachPdfs(sdk, note.id);
        if (rows.length) await refreshMeta();
      } finally {
        setBusy(null);
      }
    });

  const selected = new Set(mine.map((g) => g.key));
  const toggleTag = (g: TagGroup) =>
    guard('write', async () => {
      if (selected.has(g.key)) await detachTag(sdk, note.id, g);
      else await attachTag(sdk, note.id, g);
      await refreshMeta();
    });
  const createTag = async (name: string) => {
    const { group, reused } = await ensureTag(sdk, name).catch((e) => {
      throw new Error(friendly(e));
    });
    if (!selected.has(group.key)) await attachTag(sdk, note.id, group);
    await refreshMeta();
    return reused ? 'Đã có tag này — dùng lại' : '';
  };

  return (
    <div className="screen">
      <div className="bar">
        <button className="iconbtn" aria-label="Quay lại" onClick={p.onBack}>←</button>
        <span className={`savebar${save === 'saving' ? ' busy' : save === 'bad' ? ' bad' : ''}`} role="status">
          {save === 'saving' ? 'Đang lưu…' : save === 'bad' ? 'Chưa lưu được — sẽ thử lại' : 'Đã lưu trên máy'}
        </span>
        <button className="iconbtn" aria-label="Thao tác" aria-haspopup="menu" aria-expanded={menu} disabled={viewOnly} onClick={() => setMenu((m) => !m)}>⋯</button>
      </div>
      {menu && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => void onPin()}>{note.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}</button>
          <button role="menuitem" className="dg" onClick={() => void onTrash()}>Chuyển vào thùng rác</button>
        </div>
      )}
      <div className="body">
        {trashed && <Banner tone="warn" action={{ label: 'Khôi phục', run: () => void onRestore() }}>Ghi chú này đang ở thùng rác — chỉ xem được.</Banner>}
        {!trashed && p.readOnly && <Banner tone="warn">Chỉ đọc (READ_ONLY) — cần mạng để xác minh lại. Chữ bạn đã gõ vẫn còn.</Banner>}
        {banner && <Banner action={{ label: 'Đã hiểu', run: () => setBanner(null) }}>{banner}</Banner>}
        <input
          className="ttlinput"
          placeholder="Tiêu đề"
          aria-label="Tiêu đề"
          value={title}
          maxLength={200}
          readOnly={viewOnly}
          onFocus={() => (titleFocus.current = true)}
          onBlur={() => (titleFocus.current = false)}
          onChange={(e) => onTitle(e.target.value)}
        />
        <EditorBody editor={editor} />
        <div className="tags">
          {mine.map((g) => (
            <TagChip key={g.key} label={g.name} onRemove={viewOnly ? undefined : () => void toggleTag(g)} />
          ))}
          {!viewOnly && <TagChip label="+ Tag" onClick={() => setSheet(true)} />}
        </div>
        {atts.length > 0 && <div className="atts">{atts.map((a) => <Attachment key={a.id} sdk={sdk} a={a} removable={!viewOnly} onRemove={() => void guard('write', async () => (await detachAttachment(sdk, a.id), await refreshMeta()))} />)}</div>}
        {!viewOnly && (
          <div className="addrow">
            <button className={`btn sec${busy === 'img' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void onAddImage()}>Thêm ảnh</button>
            <button className={`btn sec${busy === 'pdf' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void onAddFile()}>Thêm tệp</button>
          </div>
        )}
      </div>
      <Toolbar editor={editor} disabled={viewOnly} />
      {sheet && <TagSheet groups={groups} selected={selected} onToggle={toggleTag} onCreate={createTag} onClose={() => setSheet(false)} />}
    </div>
  );
}

function Attachment({ sdk, a, removable, onRemove }: { sdk: Sdk; a: AttachmentRow; removable: boolean; onRemove: () => void }) {
  const [info, setInfo] = useState<{ uri: string; status: string } | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const run = () => void fileUri(sdk, a.file_id).then((r) => alive && setInfo(r));
    run();
    const iv = setInterval(run, 5000); // máy khác thấy file sau khi nó upload xong
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [sdk, a.file_id]);
  const pending = info?.status === 'local';
  return (
    <span className="att">
      <span className={`thumb ${a.kind}${info === undefined ? ' load' : ''}`}>
        {a.kind === 'image' ? (info ? <img src={info.uri} alt={a.name ?? 'Ảnh đính kèm'} /> : info === null ? 'Ảnh' : '') : 'PDF'}
      </span>
      <span className="meta">
        <span className="nm">{a.name ?? (a.kind === 'pdf' ? 'Tệp PDF' : 'Ảnh')}</span>
        <span className="muted">
          {[humanSize(a.size), info === null ? 'đang tải về…' : pending ? 'chờ tải lên' : ''].filter(Boolean).join(' · ')}
        </span>
      </span>
      {pending && <i className="wait" aria-hidden="true" />}
      {removable && <button className="rm" aria-label="Gỡ đính kèm" onClick={onRemove}>×</button>}
    </span>
  );
}
