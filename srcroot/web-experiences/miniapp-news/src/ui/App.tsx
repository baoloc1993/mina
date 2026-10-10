// Đọc báo — vỏ ứng dụng: ba tab (S19 Tin mới · S20 Đọc sau · S21 Nguồn) + sheet S22/S23, làm mới feed, đọc bài qua trình duyệt trong app,
// nhận intent `news.open`, gửi `note.create` / `calendar.reminder.create`, nhận thông báo cấu hình `config` từ shell.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getItem, groupSources, listItems, listSaved, listSourceNames, listSources, markRead, markUnread, purgeOld, removeSource, renameSource, setNoteId, setSaved,
  type ItemRow, type SourceGroup, type SourceRow, MAX_SOURCES,
} from '../data/repo';
import { noteCreatePayload, parseIntent, reminderPayload } from '../intent/intents';
import { AppError, addSource, refreshAll, refreshSource, toAppError, unpackError } from '../sources/refresh';
import { errCode, newId, type Sdk } from '../sdk';
import { hhmm, relTime } from '../time';
import { Dialog, Banner, Empty, friendly, Skeleton, Toast, type DialogButton, type ToastState } from './kit';
import { errorOf, failingCount, filterItems, groupByDay, lastUpdate, sourceOf, sourceState, suggestionsOf, type Suggestion } from './model';
import { AddSheet, ItemSheet, SourceSheet } from './Sheets';

type Tab = 'news' | 'later' | 'sources';
type Sheet = { k: 'add' } | { k: 'item'; id: string } | { k: 'source'; id: string } | null;

const POLL_MS = 3000;
const CLOCK_MS = 60_000;

interface Snapshot {
  sources: SourceRow[];
  items: ItemRow[];
  saved: ItemRow[];
  names: Map<string, { name: string; host: string; deleted: boolean }>;
}

export function App({ sdk }: { sdk: Sdk }) {
  const [tab, setTab] = useState<Tab>('news');
  const [snap, setSnap] = useState<Snapshot>({ sources: [], items: [], saved: [], names: new Map() });
  const [loaded, setLoaded] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [syncOffline, setSyncOffline] = useState(false);
  const [fetchOffline, setFetchOffline] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [dialog, setDialog] = useState<{ title: string; text: string; buttons: DialogButton[] } | null>(null);
  const [addBusy, setAddBusy] = useState<string | null>(null);
  const [addErr, setAddErr] = useState<AppError | null>(null);
  const [itemBusy, setItemBusy] = useState<'note' | 'remind' | null>(null);
  const [noteMissing, setNoteMissing] = useState(false);
  const [calendarMissing, setCalendarMissing] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sig = useRef('');
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const refreshingRef = useRef(false);
  const syncOfflineRef = useRef(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const openingRef = useRef<string | null>(null);
  openingRef.current = openingId;
  const sheetRef = useRef<Sheet>(null);
  const [allowBusy, setAllowBusy] = useState(false);
  const [remindedAt, setRemindedAt] = useState<string | null>(null);

  sheetRef.current = sheet;
  const showToast = useCallback((t: ToastState) => setToast(t), []);
  const closeToast = useCallback(() => setToast(null), []);
  const fail = useCallback((e: unknown) => showToast({ msg: friendly(e), err: true }), [showToast]);

  const groups: SourceGroup[] = useMemo(() => groupSources(snap.sources), [snap.sources]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const doRefreshRef = useRef<(auto?: boolean) => Promise<void>>(async () => undefined);

  // ---- nạp dữ liệu local (không đụng mạng) ----
  const reload = useCallback(async () => {
    try {
      const [sources, items, saved, names, info, st] = await Promise.all([listSources(sdk), listItems(sdk), listSaved(sdk), listSourceNames(sdk), sdk.sdk.info(), sdk.sync.status()]);
      setReadOnly(info.readOnly);
      const nowOffline = st.state === 'offline';
      const wasOffline = syncOfflineRef.current;
      syncOfflineRef.current = nowOffline;
      setSyncOffline(nowOffline);
      if (wasOffline && !nowOffline) {
        // Có mạng lại: bỏ banner offline và tự làm mới một lần (không chờ người dùng bấm).
        setFetchOffline(false);
        setTimeout(() => void doRefreshRef.current(true), 500);
      }
      const cfg = (info.config ?? {}) as Record<string, unknown>;
      setConfig((prev) => (JSON.stringify(prev) === JSON.stringify(cfg) ? prev : cfg));
      const s = JSON.stringify([sources, items, saved, [...names]]);
      if (s !== sig.current) {
        sig.current = s;
        setSnap({ sources, items, saved, names });
      }
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [sdk]);

  // ---- làm mới feed (AC-2) ----
  const doRefresh = useCallback(
    async (auto = false) => {
      if (refreshingRef.current) return;
      const gs = groupsRef.current;
      if (!gs.length) return;
      if (readOnlyRef.current) {
        if (!auto) showToast({ msg: 'Chỉ đọc — không tải bài mới (READ_ONLY)', err: true });
        return;
      }
      refreshingRef.current = true;
      setRefreshing(true);
      setBusyIds(new Set(gs.map((g) => g.main.id)));
      try {
        const out = await refreshAll(sdk, gs, Date.now(), (o) => setBusyIds((prev) => (prev.has(o.id) ? new Set([...prev].filter((x) => x !== o.id)) : prev)), () => syncOfflineRef.current);
        const offlineAll = out.length > 0 && out.every((o) => o.error?.code === 'OFFLINE');
        const offlineSome = out.some((o) => o.error?.code === 'OFFLINE');
        setFetchOffline(offlineAll);
        await reload();
        if (!auto) {
          if (offlineAll || (offlineSome && syncOfflineRef.current)) showToast({ msg: 'Đang offline — hiện bài đã tải' });
          else {
            const bad = out.filter((o) => !o.ok).length;
            showToast(bad ? { msg: `${bad} nguồn không tải được — xem ở Nguồn`, err: true, label: 'Xem', run: () => setTab('sources') } : { msg: 'Đã cập nhật' });
          }
        }
      } finally {
        refreshingRef.current = false;
        setRefreshing(false);
        setBusyIds(new Set());
      }
    },
    [sdk, reload, showToast],
  );
  doRefreshRef.current = doRefresh;

  // ---- khởi động: nạp → dọn 30 ngày → báo ready → tự làm mới một lần ----
  useEffect(() => {
    (async () => {
      await reload();
      try {
        if (!readOnlyRef.current) await purgeOld(sdk, Date.now());
      } catch {
        /* lần mở sau */
      }
      await reload();
      await sdk.sdk.ready().catch(() => undefined);
      void doRefresh(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // thấy dữ liệu từ máy khác: sự kiện sync + thăm dò (app nằm nền thì không thăm dò)
  useEffect(() => {
    const offSync = sdk.sdk.on('sync', () => void reload());
    const offResume = sdk.sdk.on('resume', () => {
      setNow(Date.now());
      void reload();
    });
    const offConfig = sdk.sdk.on('config', (c) => setConfig(c && typeof c === 'object' ? (c as Record<string, unknown>) : {}));
    const iv = setInterval(() => {
      if (!document.hidden) void reload();
    }, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => {
      offSync();
      offResume();
      offConfig();
      clearInterval(iv);
      clearInterval(clock);
    };
  }, [sdk, reload]);

  // ---- mở bài ----
  const openItem = useCallback(
    async (item: ItemRow) => {
      if (openingRef.current) return; // đang mở một bài: bỏ qua chạm thứ hai (không đánh dấu đã đọc bài chưa mở)
      openingRef.current = item.id;
      setOpeningId((cur) => cur ?? item.id); // phản hồi tức thì: Chrome Custom Tabs mất 3–5 giây mới bật
      setTimeout(() => setOpeningId((cur) => (cur === item.id ? null : cur)), 6000);
      try {
        await sdk.ui.openUrl(item.link);
        if (!readOnlyRef.current && item.read_at_ms === null) {
          await markRead(sdk, item.id, Date.now());
          await reload();
        }
      } catch (e) {
        fail(e);
      } finally {
        setTimeout(() => setOpeningId(null), 800);
      }
    },
    [sdk, reload, fail],
  );

  // ---- intent từ app khác ----
  useEffect(
    () =>
      sdk.sdk.on('intent', (evt) => {
        const p = parseIntent(evt.type, evt.payload);
        if (p.kind !== 'news.open') return;
        void (async () => {
          const it = await getItem(sdk, p.itemId).catch(() => null);
          if (!it) {
            setSheet(null);
            setNotFound(true);
            return;
          }
          setNotFound(false);
          setSheet(null);
          setFilter(null);
          setTab(it.saved_at_ms !== null ? 'later' : 'news');
          setHighlight(it.id);
          setTimeout(() => setHighlight((h) => (h === it.id ? null : h)), 3500);
          await reload();
          void openItem(it);
        })();
      }),
    [sdk, reload, openItem],
  );

  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => document.getElementById(`art-${highlight}`)?.scrollIntoView({ block: 'center' }), 50);
    return () => clearTimeout(t);
  }, [highlight, tab, snap]);

  // ---- thêm / bỏ / đổi tên nguồn ----
  const suggestions: Suggestion[] = useMemo(() => suggestionsOf(config), [config]);

  const doAdd = useCallback(
    async (raw: string, opt: { name?: string; suggestedKey?: string } = {}) => {
      setAddBusy(opt.suggestedKey ?? 'url');
      setAddErr(null);
      try {
        const r = await addSource(sdk, raw, { groups: groupsRef.current, now: Date.now(), ...opt });
        if (r.status === 'exists') {
          showToast({ msg: `Đã có nguồn này: ${r.source.name}` });
          setSheet(null);
        } else {
          showToast({ msg: `Đã thêm ${r.source.name} · tên sửa được ở Nguồn` });
          if (!opt.suggestedKey) setSheet(null);
        }
        await reload();
      } catch (e) {
        const ae = toAppError(e, '');
        setAddErr(ae);
        // Sheet đã đóng trong lúc đang tải (người dùng vội): báo kết quả bằng toast
        // Thêm từ danh sách gợi ý: lỗi hiện cuối sheet (dưới ô dán URL), ngoài tầm nhìn — dogfood vòng 7 → báo thêm bằng toast sát chỗ vừa bấm.
        if (sheetRef.current?.k !== 'add' || opt.suggestedKey) showToast({ msg: `${ae.message} (${ae.code})`, err: true });
      } finally {
        setAddBusy(null);
      }
    },
    [sdk, reload, showToast],
  );

  const confirmRemove = (g: SourceGroup) =>
    setDialog({
      title: `Bỏ nguồn ${g.main.name}?`,
      text: 'Bài chưa lưu của nguồn này sẽ bị bỏ, bài Đọc sau vẫn còn.',
      buttons: [
        {
          label: 'Bỏ nguồn',
          danger: true,
          run: () => {
            void (async () => {
              try {
                await removeSource(sdk, g.ids);
                setFilter((f) => (f && g.ids.includes(f) ? null : f));
                await reload();
              } catch (e) {
                fail(e);
              }
            })();
          },
        },
        { label: 'Giữ lại', secondary: true, run: () => undefined },
      ],
    });

  const retrySource = async (g: SourceGroup) => {
    if (busyIds.has(g.main.id)) return;
    setBusyIds((p) => new Set(p).add(g.main.id));
    try {
      const o = await refreshSource(sdk, g, Date.now());
      if (o.error?.code === 'OFFLINE') showToast({ msg: 'Đang offline — hiện bài đã tải' });
      else if (!o.ok) showToast({ msg: `${o.error?.message} (${o.error?.code})`, err: true });
      await reload();
    } finally {
      setBusyIds((p) => new Set([...p].filter((x) => x !== g.main.id)));
    }
  };

  const allowAgain = async (g: SourceGroup) => {
    if (allowBusy) return;
    setAllowBusy(true);
    try {
      const r = await sdk.net.requestAccess({ host: g.main.host, reason: `Để tải tin từ ${g.main.host}` });
      if (!r.granted) {
        showToast({ msg: `Chưa cho phép truy cập ${g.main.host} (NET_BLOCKED)`, err: true });
        return;
      }
      // Quyền theo host: tải lại MỌI nguồn cùng host đang báo NET_BLOCKED, không chỉ nguồn vừa chạm.
      const same = groupsRef.current.filter((x) => x.main.host === g.main.host && (x.main.id === g.main.id || errorOf(x.main)?.code === 'NET_BLOCKED'));
      for (const x of same) await retrySource(x);
    } catch (e) {
      fail(e);
    } finally {
      setAllowBusy(false);
    }
  };

  // ---- thao tác bài ----
  const toggleSaved = async (item: ItemRow) => {
    try {
      await setSaved(sdk, item.id, item.saved_at_ms === null ? Date.now() : null);
      await reload();
    } catch (e) {
      fail(e);
    }
  };
  const toggleRead = async (item: ItemRow) => {
    try {
      if (item.read_at_ms === null) await markRead(sdk, item.id, Date.now());
      else await markUnread(sdk, item.id);
      await reload();
    } catch (e) {
      fail(e);
    }
  };

  const doNote = async (item: ItemRow) => {
    if (itemBusy) return;
    if (item.note_id) {
      // Đã lưu thành note: mở lại note (mất → Ghi chú hiện khuôn NOT_FOUND).
      try {
        await sdk.intent.send('note.open', { noteId: item.note_id }, { mode: 'open' });
      } catch (e) {
        if (errCode(e) === 'INTENT_NO_HANDLER') setNoteMissing(true);
        else fail(e);
      }
      return;
    }
    setItemBusy('note');
    setNoteMissing(false);
    const id = newId();
    try {
      // Ghi nhớ id TRƯỚC khi gửi: gửi xong mà PATCH hỏng thì lần bấm sau vẫn dùng đúng id, Ghi chú không tạo trùng.
      await setNoteId(sdk, item.id, id);
      await sdk.intent.send('note.create', noteCreatePayload(item, id), { mode: 'create' });
      await reload();
    } catch (e) {
      await sdk.db.execute('UPDATE items SET note_id = ? WHERE id = ?', [null, item.id]).catch(() => undefined);
      if (errCode(e) === 'INTENT_NO_HANDLER') setNoteMissing(true);
      else fail(e);
      await reload();
    } finally {
      setItemBusy(null);
    }
  };

  const doRemind = async (item: ItemRow, at: string) => {
    if (itemBusy) return;
    setItemBusy('remind');
    setCalendarMissing(false);
    try {
      await sdk.intent.send('calendar.reminder.create', reminderPayload(item, newId(), at), { mode: 'create' });
      if (item.saved_at_ms === null) await setSaved(sdk, item.id, Date.now()); // bài phải có mặt offline khi đến giờ nhắc
      setRemindedAt(at);
      await reload();
    } catch (e) {
      if (errCode(e) === 'INTENT_NO_HANDLER') setCalendarMissing(true);
      else fail(e);
    } finally {
      setItemBusy(null);
    }
  };

  // ---- dữ liệu hiển thị ----
  const info = useCallback((it: ItemRow) => sourceOf(it, groups, snap.names), [groups, snap.names]);
  const activeItems = useMemo(() => snap.items.filter((i) => !info(i).removed), [snap.items, info]);
  const newsItems = useMemo(() => filterItems(activeItems, filter, groups), [activeItems, filter, groups]);
  const days = useMemo(() => groupByDay(newsItems, now), [newsItems, now]);
  const updated = lastUpdate(groups);
  const failing = failingCount(groups);
  const offline = syncOffline || fetchOffline;
  const sheetItem = sheet?.k === 'item' ? ([...snap.items, ...snap.saved].find((i) => i.id === sheet.id) ?? null) : null;
  const sheetSource = sheet?.k === 'source' ? (groups.find((g) => g.main.id === sheet.id) ?? null) : null;

  const row = (it: ItemRow) => {
    const s = info(it);
    return (
      <div key={it.id} id={`art-${it.id}`} className={`arow${it.read_at_ms !== null ? ' read' : ''}${highlight === it.id ? ' hl' : ''}`}>
        <button className="mid" disabled={openingId === it.id} onClick={() => void openItem(it)} aria-label={`Mở bài: ${it.title}`}>
          <span className="ttl">{it.title}</span>
          <span className="sub">
            <span>{s.name}{s.removed ? ' · nguồn đã bỏ' : ''}</span>
            <span>{openingId === it.id ? 'Đang mở…' : relTime(it.published_at_ms ?? it.fetched_at_ms, now)}</span>
            {it.read_at_ms !== null && <span className="read-tag">Đã đọc</span>}
            {it.note_id && <span className="tagchip mini">Note</span>}
          </span>
          {it.summary && <span className="sum">{it.summary}</span>}
        </button>
        <div className="acts">
          <button className={`ab${it.saved_at_ms !== null ? ' on' : ''}`} disabled={readOnly} aria-pressed={it.saved_at_ms !== null} aria-label={it.saved_at_ms !== null ? 'Bỏ lưu đọc sau' : 'Đọc sau'} onClick={() => void toggleSaved(it)}>
            <span aria-hidden="true">{it.saved_at_ms !== null ? '★' : '☆'}</span>
            <span className="ablbl" aria-hidden="true">{it.saved_at_ms !== null ? 'Đã lưu' : 'Đọc sau'}</span>
          </button>
          <button className="ab" aria-label="Thêm hành động" onClick={() => setSheet({ k: 'item', id: it.id })}>
            ⋯
          </button>
        </div>
      </div>
    );
  };

  const body = (() => {
    if (notFound) {
      return (
        <div className="body">
          <Empty glyph="?" tone="err" action={{ label: 'Về Tin mới', run: () => setNotFound(false), secondary: true }}>
            Không tìm thấy bài này (NOT_FOUND)
          </Empty>
        </div>
      );
    }
    if (tab === 'news') {
      return (
        <>
          <div className="bar">
            <div className="title">Tin mới</div>
            <button className={`iconbtn txt${refreshing ? ' busy' : ''}`} disabled={refreshing || readOnly || groups.length === 0} onClick={() => void doRefresh()}>
              {refreshing ? <><span className="spin" aria-hidden="true" /> Đang tải…</> : 'Làm mới'}
            </button>
          </div>
          <div className="body">
            {!loaded ? (
              <Skeleton />
            ) : groups.length === 0 ? (
              <Empty glyph="◎" action={{ label: 'Thêm nguồn', run: () => { setAddErr(null); setSheet({ k: 'add' }); }, disabled: readOnly }}>
                Chưa có nguồn nào — thêm báo bạn hay đọc
              </Empty>
            ) : (
              <>
                {groups.length > 1 && (
                  <div className="chips" role="group" aria-label="Lọc theo nguồn">
                    <button className={`tagchip${filter === null ? ' on' : ''}`} aria-pressed={filter === null} onClick={() => setFilter(null)}>Tất cả</button>
                    {groups.map((g) => (
                      <button key={g.main.id} className={`tagchip${filter === g.main.id ? ' on' : ''}`} aria-pressed={filter === g.main.id} onClick={() => setFilter(g.main.id)}>
                        {g.main.name}
                      </button>
                    ))}
                  </div>
                )}
                {readOnly && <Banner tone="warn">Chỉ đọc — không tải bài mới (READ_ONLY). Đọc bài đã có vẫn được.</Banner>}
                {offline && <Banner tone="warn">Đang offline — hiện bài đã tải{updated ? ` lúc ${hhmm(updated)}` : ''}</Banner>}
                {failing > 0 && <Banner tone="warn" action={{ label: 'Xem', run: () => setTab('sources') }}>{failing} nguồn không tải được — xem ở Nguồn</Banner>}
                {updated && <div className="updated">Cập nhật lần cuối {hhmm(updated)}{refreshing ? ' · đang tải…' : ''}</div>}
                {newsItems.length === 0 ? (
                  filter ? (
                    <Empty>Không có bài nào của nguồn này</Empty>
                  ) : (
                    <Empty glyph="↻" action={{ label: 'Làm mới', run: () => void doRefresh(), disabled: refreshing || readOnly }}>
                      Chưa tải được bài nào — bấm Làm mới khi có mạng
                    </Empty>
                  )
                ) : (
                  days.map((d) => (
                    <section key={d.key}>
                      <p className="group">{d.label}</p>
                      <div className="list">{d.items.map(row)}</div>
                    </section>
                  ))
                )}
              </>
            )}
          </div>
        </>
      );
    }
    if (tab === 'later') {
      return (
        <>
          <div className="bar">
            <div className="title">Đọc sau</div>
          </div>
          <div className="body">
            {!loaded ? (
              <Skeleton />
            ) : (
              <>
                <div className="muted">Bài bạn lưu — chỉ tiêu đề, tóm tắt và liên kết. Không bao giờ bị dọn.</div>
                {offline && <Banner tone="warn">Đang offline — xem được tiêu đề và tóm tắt; mở bài cần mạng</Banner>}
                {snap.saved.length === 0 ? <Empty glyph="☆">Chưa lưu bài nào — bấm ☆ Đọc sau ở một bài</Empty> : <div className="list">{snap.saved.map(row)}</div>}
              </>
            )}
          </div>
        </>
      );
    }
    return (
      <>
        <div className="bar">
          <div className="title">Nguồn</div>
          <button className="iconbtn txt" disabled={readOnly} onClick={() => { setAddErr(null); setSheet({ k: 'add' }); }}>
            + Thêm
          </button>
        </div>
        <div className="body">
          {!loaded ? (
            <Skeleton />
          ) : groups.length === 0 ? (
            <Empty glyph="◎" action={{ label: 'Thêm nguồn', run: () => { setAddErr(null); setSheet({ k: 'add' }); }, disabled: readOnly }}>
              Chưa có nguồn nào — thêm báo bạn hay đọc
            </Empty>
          ) : (
            <>
              <div className="muted">
                {groups.length}/{MAX_SOURCES} nguồn · bài giữ 30 ngày, bài đọc sau giữ mãi
              </div>
              {readOnly && <Banner tone="warn">Chỉ đọc — không thêm hay bỏ nguồn được (READ_ONLY)</Banner>}
              <div className="list">
                {groups.map((g) => {
                  const st = sourceState(g.main, busyIds.has(g.main.id));
                  const err = errorOf(g.main);
                  return (
                    <div className="srow" key={g.main.id}>
                      <span className={`st ${st === 'ok' ? '' : st}`} aria-hidden="true" />
                      <button className="mid" onClick={() => setSheet({ k: 'source', id: g.main.id })} aria-label={`${g.main.name}. ${err ? err.message : 'Mở tuỳ chọn nguồn'}`}>
                        <span className="nm">{g.main.name}</span>
                        <span className={`sub${err ? ' err' : ''}`}>
                          {err ? `${err.message} (${err.code})` : `${g.main.host}${g.main.last_fetched_at_ms ? ` · cập nhật ${hhmm(g.main.last_fetched_at_ms)}` : ''}`}
                        </span>
                      </button>
                      <button className="btn slim sec" disabled={readOnly} onClick={() => confirmRemove(g)} aria-label={`Bỏ nguồn ${g.main.name}`}>
                        Bỏ
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </>
    );
  })();

  return (
    <div className="screen">
      {body}
      <nav className="tabs" aria-label="Chuyển màn">
        {([['news', '▤', 'Tin mới'], ['later', '☆', `Đọc sau${snap.saved.length ? ` (${snap.saved.length})` : ''}`], ['sources', '◎', 'Nguồn']] as const).map(([k, ic, label]) => (
          <button key={k} className={tab === k && !notFound ? 'on' : ''} aria-current={tab === k && !notFound ? 'page' : undefined} onClick={() => { setNotFound(false); setTab(k); }}>
            <span className="ic" aria-hidden="true">{ic}</span>
            {label}
          </button>
        ))}
      </nav>

      {sheet?.k === 'add' && (
        <AddSheet
          suggestions={suggestions}
          groups={groups}
          readOnly={readOnly}
          busyKey={addBusy}
          error={addErr}
          onAddSuggestion={(s) => void doAdd(s.feed_url, { name: s.name, suggestedKey: s.key })}
          onAddUrl={(raw) => void doAdd(raw)}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.k === 'item' && sheetItem && (
        <ItemSheet
          item={sheetItem}
          sourceName={`${info(sheetItem).name}${info(sheetItem).removed ? ' · nguồn đã bỏ' : ''} · ${relTime(sheetItem.published_at_ms ?? sheetItem.fetched_at_ms, now)}`}
          readOnly={readOnly}
          busy={itemBusy}
          noteMissing={noteMissing}
          calendarMissing={calendarMissing}
          remindedAt={remindedAt}
          now={now}
          onOpen={() => void openItem(sheetItem)}
          onToggleSaved={() => void toggleSaved(sheetItem)}
          onNote={() => void doNote(sheetItem)}
          onRemind={(at) => void doRemind(sheetItem, at)}
          onToggleRead={() => void toggleRead(sheetItem)}
          onClose={() => { setNoteMissing(false); setCalendarMissing(false); setRemindedAt(null); setSheet(null); }}
        />
      )}
      {sheet?.k === 'source' && sheetSource && (
        <SourceSheet
          key={sheetSource.main.id}
          group={sheetSource}
          readOnly={readOnly}
          busy={busyIds.has(sheetSource.main.id)}
          allowBusy={allowBusy}
          onRename={(name) => void (async () => { try { await renameSource(sdk, sheetSource.ids, name); await reload(); setSheet(null); } catch (e) { fail(e); } })()}
          onRetry={() => void retrySource(sheetSource)}
          onAllow={() => void allowAgain(sheetSource)}
          onClose={() => setSheet(null)}
        />
      )}
      {dialog && <Dialog title={dialog.title} text={dialog.text} buttons={dialog.buttons} onClose={() => setDialog(null)} />}
      <Toast toast={toast} onClose={closeToast} />
    </div>
  );
}

void unpackError;
