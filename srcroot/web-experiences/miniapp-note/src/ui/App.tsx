// Ghi chú — vỏ ứng dụng: điều hướng S11 ↔ S12 ↔ S13, nhận intent `note.create` / `note.open`, lưu khi `suspend`, đồng bộ nền.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteSession } from '../crdt/session';
import { blockSignatures, createFromIntent, createNote, discardIfEmpty, getNote, listNotes, listTrash, purgeExpired, reindex, restoreNote, type NoteRow } from '../data/repo';
import { listTagGroups, tagsByNote, type TagGroup } from '../data/tags';
import { searchTerms } from '../search/normalize';
import { errCode, UUID_RE, type Sdk } from '../sdk';
import { EditorScreen } from './EditorScreen';
import { Dialog, friendly, Toast, type ToastState } from './kit';
import { ListScreen, TrashScreen } from './ListScreen';

type Route = { name: 'list' } | { name: 'trash' } | { name: 'edit'; id: string; from: 'list' | 'trash' };
const POLL_MS = 3000;

export function App({ sdk }: { sdk: Sdk }) {
  const [route, setRoute] = useState<Route>({ name: 'list' });
  const [q, setQ] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [trash, setTrash] = useState<NoteRow[]>([]);
  const [groups, setGroups] = useState<TagGroup[]>([]);
  const [tagMap, setTagMap] = useState<Map<string, TagGroup[]>>(new Map());
  const [hasAny, setHasAny] = useState(false);
  const [ready, setReady] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [dialog, setDialog] = useState<{ title: string; text: string; buttons: { label: string; run: () => void; secondary?: boolean }[] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const terms = searchTerms(q);
  const termsKey = terms.join(' ');
  const session = useRef<NoteSession | null>(null);
  const lastSig = useRef<Map<string, string> | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;

  const reload = useCallback(async () => {
    const t = termsKey ? termsKey.split(' ') : [];
    const [list, tr, gs, all] = await Promise.all([listNotes(sdk, t), listTrash(sdk), listTagGroups(sdk), t.length ? listNotes(sdk, []) : null]);
    setNotes(list);
    setTrash(tr);
    setGroups(gs);
    setHasAny((all ?? list).length > 0);
    setTagMap(await tagsByNote(sdk, gs));
    setReady(true);
  }, [sdk, termsKey]);

  const refreshStatus = useCallback(async () => {
    try {
      const [info, st] = await Promise.all([sdk.sdk.info(), sdk.sync.status()]);
      setReadOnly(info.readOnly);
      setSyncing(st.state === 'syncing' && !hasAnyRef.current ? 'Đang tải ghi chú từ máy chủ…' : null);
    } catch {
      /* lần sau */
    }
  }, [sdk]);
  const hasAnyRef = useRef(false);
  hasAnyRef.current = hasAny;

  // Nền: tìm note lệch search_text sau khi hợp nhất (chữ ký dòng note_blocks đổi mà không phải note đang mở)
  const background = useCallback(async () => {
    try {
      const sigs = await blockSignatures(sdk);
      const prev = lastSig.current;
      lastSig.current = sigs;
      const active = routeRef.current.name === 'edit' ? (routeRef.current as { id: string }).id : null;
      const changed = prev ? [...sigs].filter(([id, s]) => prev.get(id) !== s && id !== active).map(([id]) => id) : [];
      if ((changed.length || !prev) && (await reindex(sdk, changed)) > 0) await reload();
    } catch {
      /* lần sau */
    }
  }, [sdk, reload]);

  // khởi động: dọn thùng rác quá hạn, nạp dữ liệu, báo ready
  useEffect(() => {
    (async () => {
      await purgeExpired(sdk).catch(() => 0);
      await reload();
      await refreshStatus();
      await background();
      await sdk.sdk.ready().catch(() => undefined);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => void reload().catch(() => undefined), [reload]);

  // thấy dữ liệu từ máy khác: sự kiện sync + thăm dò
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return; // app nằm nền thì không thăm dò (đỡ pin, đỡ N+1 khi nhiều lời gọi dồn)
      void reload().catch(() => undefined);
      void refreshStatus();
      void background();
    };
    const off = sdk.sdk.on('sync', tick);
    const iv = setInterval(tick, POLL_MS);
    const offResume = sdk.sdk.on('resume', tick);
    return () => {
      off();
      offResume();
      clearInterval(iv);
    };
  }, [sdk, reload, refreshStatus, background]);

  // suspend: shell chờ ≤ 1,5 s (hợp đồng "≥ 500 ms để lưu") — ép lưu chữ đang gõ
  useEffect(() => sdk.sdk.on('suspend', async () => void (await session.current?.flush().catch(() => undefined))), [sdk]);

  const showToast = useCallback((t: ToastState) => setToast(t), []);
  const closeToast = useCallback(() => setToast(null), []);

  const open = useCallback((id: string, from: 'list' | 'trash' = 'list') => setRoute({ name: 'edit', id, from }), []);

  const openFromIntent = useCallback(
    async (noteId: string) => {
      const note = await getNote(sdk, noteId);
      if (!note) return setRoute({ name: 'edit', id: noteId, from: 'list' }); // EditorScreen hiện khuôn NOT_FOUND
      if (note.trashed_at_ms !== null) {
        setDialog({
          title: 'Ghi chú này đang ở thùng rác',
          text: 'Khôi phục để sửa lại, hoặc chỉ xem.',
          buttons: [
            { label: 'Chỉ xem', secondary: true, run: () => open(noteId, 'trash') },
            {
              label: 'Khôi phục',
              run: () =>
                void restoreNote(sdk, noteId).then(
                  () => (open(noteId, 'list'), showToast({ msg: 'Đã khôi phục ghi chú' })),
                  (e) => showToast({ msg: friendly(e), err: true }),
                ),
            },
          ],
        });
        return;
      }
      open(noteId, 'list');
    },
    [sdk, open, showToast],
  );

  // intent từ app khác (shell đã kiểm schema; ở đây kiểm lại tối thiểu vì dữ liệu đến từ ngoài)
  useEffect(
    () =>
      sdk.sdk.on('intent', (evt) => {
        const p = (evt.payload && typeof evt.payload === 'object' ? evt.payload : {}) as Record<string, unknown>;
        if (evt.type === 'note.create' && typeof p.title === 'string' && p.title) {
          const id = typeof p.id === 'string' && UUID_RE.test(p.id) ? p.id : undefined;
          createFromIntent(sdk, {
            id,
            title: p.title.slice(0, 200),
            body: typeof p.body === 'string' ? p.body.slice(0, 20000) : undefined,
            url: typeof p.url === 'string' && /^https?:\/\//.test(p.url) ? p.url.slice(0, 2048) : undefined,
          }).then(
            () => void reload(),
            (e) => showToast({ msg: errCode(e) === 'READ_ONLY' ? friendly(e) : 'Không tạo được ghi chú từ app khác. Thử lại sau.', err: true }),
          );
        } else if (evt.type === 'note.open' && typeof p.noteId === 'string' && UUID_RE.test(p.noteId)) {
          void openFromIntent(p.noteId);
        }
      }),
    [sdk, reload, openFromIntent, showToast],
  );

  const newNote = async () => {
    if (creatingRef.current) return; // bấm đúp không được đẻ hai ghi chú (C1 "đang xử lý")
    creatingRef.current = true;
    setCreating(true);
    try {
      const id = await createNote(sdk);
      open(id, 'list');
    } catch (e) {
      showToast({ msg: friendly(e), err: true });
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const leaveEditor = async (id: string, from: 'list' | 'trash') => {
    await session.current?.flush().catch(() => undefined);
    await discardIfEmpty(sdk, id).catch(() => undefined); // note bấm "Ghi chú mới" rồi thoát mà chưa gõ gì thì không để lại dòng trống
    await reload().catch(() => undefined);
    setRoute(from === 'trash' ? { name: 'trash' } : { name: 'list' });
  };

  const onTrashed = async (id: string) => {
    setRoute({ name: 'list' });
    await reload().catch(() => undefined);
    showToast({
      msg: 'Đã chuyển vào thùng rác',
      label: 'Hoàn tác',
      run: () => void restoreNote(sdk, id).then(() => reload(), (e) => showToast({ msg: friendly(e), err: true })),
    });
  };

  const restoreFromTrash = async (id: string) => {
    setBusyId(id);
    try {
      await restoreNote(sdk, id);
      await reload();
      showToast({ msg: 'Đã khôi phục ghi chú' });
    } catch (e) {
      showToast({ msg: friendly(e), err: true });
    } finally {
      setBusyId(null);
    }
  };

  let view;
  if (route.name === 'edit') {
    view = (
      <EditorScreen
        sdk={sdk}
        id={route.id}
        readOnly={readOnly}
        toast={showToast}
        register={(s) => (session.current = s)}
        onBack={() => void leaveEditor(route.id, route.from)}
        onTrashed={(id) => void onTrashed(id)}
      />
    );
  } else if (route.name === 'trash') {
    view = <TrashScreen trash={trash} busyId={busyId} onBack={() => setRoute({ name: 'list' })} onOpen={(id) => open(id, 'trash')} onRestore={(id) => void restoreFromTrash(id)} />;
  } else {
    view = (
      <ListScreen
        sdk={sdk}
        ready={ready}
        readOnly={readOnly}
        notes={notes}
        groups={groups}
        tagMap={tagMap}
        trashCount={trash.length}
        q={q}
        terms={terms}
        setQ={setQ}
        tagFilter={tagFilter}
        setTagFilter={setTagFilter}
        hasAny={hasAny}
        creating={creating}
        syncing={syncing}
        onOpen={(id) => open(id, 'list')}
        onNew={() => void newNote()}
        onTrash={() => setRoute({ name: 'trash' })}
      />
    );
  }
  return (
    <>
      {view}
      <Toast toast={toast} onClose={closeToast} />
      {dialog && <Dialog {...dialog} onClose={() => setDialog(null)} />}
    </>
  );
}
