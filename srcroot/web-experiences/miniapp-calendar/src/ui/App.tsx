// Lịch — vỏ ứng dụng: điều hướng S15 ↔ S16 ↔ S17, nhận intent (`calendar.reminder.create`, `calendar.event.open`, bấm thông báo),
// đối chiếu thông báo sau mỗi thay đổi / sync / resume, gửi `note.open` khi mở nguồn.
import { useCallback, useEffect, useRef, useState } from 'react';
import { clearOverride, createReminderFromIntent, editThisOnly, getEvent, insertEvent, loadAll, putOverride, removeEvent, setDoneAt, updateEvent } from '../data/repo';
import { NOTE_APP, parseIntent } from '../intent/intents';
import { reconcile } from '../notify/reconcile';
import { addDays, type Ymd } from '../recur/dates';
import type { EventRow, Kind, OverrideRow } from '../recur/model';
import { occurrences, type Env, type Occurrence } from '../recur/occurrences';
import { deviceTimeZoneName, deviceZone } from '../recur/zone';
import { errCode, newId, type Sdk } from '../sdk';
import { DetailScreen } from './DetailScreen';
import { EditScreen } from './EditScreen';
import { buildRow, seriesStartDate, thisOnlyPatch, type Form } from './form';
import { Dialog, friendly, Sheet, Toast, type DialogButton, type ToastState } from './kit';
import { MainScreen } from './MainScreen';

type Route =
  | { name: 'main' }
  | { name: 'edit'; eventId: string | null; occDate: Ymd | null; kind: Kind; date: Ymd }
  | { name: 'detail'; eventId: string; occDate: Ymd }
  | { name: 'notfound' };

const POLL_MS = 3000;
const RECONCILE_MS = 5 * 60_000;
const env = (): Env => ({ zone: deviceZone, now: Date.now() });
const today = (): Ymd => deviceZone.msToLocal(Date.now()).slice(0, 10);
const sigOf = (events: EventRow[], ovs: OverrideRow[]) => JSON.stringify([events, ovs]);

export function App({ sdk }: { sdk: Sdk }) {
  const [route, setRoute] = useState<Route>({ name: 'main' });
  const [data, setData] = useState<{ events: EventRow[]; overrides: OverrideRow[] }>({ events: [], overrides: [] });
  const [loaded, setLoaded] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [denied, setDenied] = useState(false);
  const [resetN, setResetN] = useState(0);
  const [noteMissing, setNoteMissing] = useState(false);
  const [view, setView] = useState<'day' | 'week'>('week');
  const [selected, setSelected] = useState<Ymd>(today());
  const [toast, setToast] = useState<ToastState | null>(null);
  const [dialog, setDialog] = useState<{ title: string; text: string; buttons: DialogButton[] } | null>(null);
  const [addSheet, setAddSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const sig = useRef('');
  const dataRef = useRef(data);
  dataRef.current = data;
  const firstReconcile = useRef(true);

  const showToast = useCallback((t: ToastState) => setToast(t), []);
  const closeToast = useCallback(() => setToast(null), []);

  const doReconcile = useCallback(
    async (force?: Iterable<string>) => {
      try {
        const r = await reconcile(sdk, { env: env(), force });
        setDenied(r.denied);
        if (firstReconcile.current) {
          firstReconcile.current = false;
          if (r.scheduled > 0 && !r.denied) {
            setResetN(r.scheduled);
            setTimeout(() => setResetN(0), 6000);
          }
        }
      } catch {
        /* lần sau */
      }
    },
    [sdk],
  );

  const refresh = useCallback(
    async (opts: { reconcile?: boolean; force?: Iterable<string> } = {}) => {
      try {
        const [d, info] = await Promise.all([loadAll(sdk), sdk.sdk.info()]);
        setReadOnly(info.readOnly);
        const s = sigOf(d.events, d.overrides);
        const changed = s !== sig.current;
        if (changed) {
          sig.current = s;
          setData(d);
        }
        setLoaded(true);
        // đối chiếu thông báo chạy NỀN — lần đầu shell hỏi quyền thông báo (hộp thoại hệ thống) nên không được chặn nút Lưu
        if (changed || opts.reconcile) void doReconcile(opts.force);
        return d;
      } catch {
        setLoaded(true);
        return dataRef.current;
      }
    },
    [sdk, doReconcile],
  );

  // khởi động: nạp dữ liệu → đối chiếu thông báo (đặt lại sau khởi động máy / force-stop) → báo ready
  useEffect(() => {
    (async () => {
      await refresh({ reconcile: true });
      await sdk.sdk.ready().catch(() => undefined);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // thấy dữ liệu từ máy khác: sự kiện sync + thăm dò (app nằm nền thì không thăm dò)
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    const offSync = sdk.sdk.on('sync', () => void refresh({ reconcile: true }));
    const offResume = sdk.sdk.on('resume', () => {
      setSelected((s) => s);
      void refresh({ reconcile: true });
    });
    const iv = setInterval(tick, POLL_MS);
    const iv2 = setInterval(() => void doReconcile(), RECONCILE_MS);
    return () => {
      offSync();
      offResume();
      clearInterval(iv);
      clearInterval(iv2);
    };
  }, [sdk, refresh, doReconcile]);

  const fail = useCallback((e: unknown) => showToast({ msg: friendly(e), err: true }), [showToast]);

  // ---- tìm lần xuất hiện ----
  const findOcc = useCallback((eventId: string, occDate: Ymd, d = dataRef.current): Occurrence | null => {
    const ev = d.events.find((e) => e.id === eventId);
    if (!ev) return null;
    const os = occurrences(ev, d.overrides.filter((o) => o.event_id === eventId), addDays(occDate, -30), addDays(occDate, 30), env());
    return os.find((o) => o.occDate === occDate) ?? null;
  }, []);

  const nextOccDate = useCallback((ev: EventRow, d = dataRef.current): Ymd => {
    const t = today();
    const os = occurrences(ev, d.overrides.filter((o) => o.event_id === ev.id), addDays(t, -1), addDays(t, 400), env());
    return (os.find((o) => !o.done) ?? os[0])?.occDate ?? ev.start_local.slice(0, 10);
  }, []);

  const openSource = useCallback(
    async (srcId: string) => {
      try {
        await sdk.intent.send('note.open', { noteId: srcId }, { mode: 'open' });
        setNoteMissing(false);
      } catch (e) {
        if (errCode(e) === 'INTENT_NO_HANDLER') setNoteMissing(true);
        else fail(e);
      }
    },
    [sdk, fail],
  );

  // ---- intent từ app khác / bấm thông báo ----
  useEffect(
    () =>
      sdk.sdk.on('intent', (evt) => {
        const p = parseIntent(evt.type, evt.payload);
        void (async () => {
          const d = await loadAll(sdk).catch(() => dataRef.current);
          if (p.kind === 'reminder.create') {
            try {
              const r = await createReminderFromIntent(sdk, p.payload, deviceTimeZoneName(), (ms) => deviceZone.msToLocal(ms));
              if (r === 'created') {
                const start = typeof p.payload.at === 'string' ? p.payload.at.slice(0, 10) : deviceZone.msToLocal(p.payload.at).slice(0, 10);
                await refresh({ reconcile: true, force: [`${p.payload.id}|${start}`] });
              }
            } catch (e) {
              if (errCode(e) !== 'READ_ONLY') showToast({ msg: 'Không tạo được lời nhắc từ app khác. Thử lại sau.', err: true });
            }
          } else if (p.kind === 'event.open') {
            const ev = d.events.find((e) => e.id === p.eventId);
            setNoteMissing(false);
            setRoute(ev ? { name: 'detail', eventId: ev.id, occDate: nextOccDate(ev, d) } : { name: 'notfound' });
          } else if (p.kind === 'notification.open') {
            const ev = d.events.find((e) => e.id === p.eventId);
            setNoteMissing(false);
            if (!ev) return setRoute({ name: 'notfound' });
            setRoute({ name: 'detail', eventId: ev.id, occDate: p.occDate });
            // lời nhắc có nguồn là ghi chú: bấm thông báo → mở lại đúng note (AC-2/AC-4)
            if (ev.src_app === NOTE_APP && ev.src_id) void openSource(ev.src_id);
          }
        })();
      }),
    [sdk, refresh, nextOccDate, openSource, showToast],
  );

  // ---- thao tác ----
  const afterWrite = useCallback((force?: Iterable<string>) => refresh({ reconcile: true, force }), [refresh]);

  const toggleDone = async (o: Occurrence) => {
    try {
      if (o.recurring) {
        if (o.done) await clearOverride(sdk, o.eventId, o.occDate, 'done');
        else await putOverride(sdk, o.eventId, o.occDate, 'done', { at_ms: Date.now() });
      } else await setDoneAt(sdk, o.eventId, o.done ? null : Date.now());
      await afterWrite();
    } catch (e) {
      fail(e);
    }
  };

  const snooze = async (o: Occurrence, until: string) => {
    try {
      await putOverride(sdk, o.eventId, o.occDate, 'snooze', { until_local: until });
      await afterWrite();
      showToast({ msg: `Hoãn đến ${until.slice(11)}` });
    } catch (e) {
      fail(e);
    }
  };
  const unsnooze = async (o: Occurrence) => {
    try {
      await clearOverride(sdk, o.eventId, o.occDate, 'snooze');
      await afterWrite();
    } catch (e) {
      fail(e);
    }
  };

  const save = async (form: Form, scope: 'all' | 'this', eventId: string | null, occDate: Ymd | null) => {
    if (busy) return;
    setBusy(true);
    try {
      const e = env();
      if (!eventId) {
        const row = buildRow(form, newId(), null, e);
        await insertEvent(sdk, row);
        // chỉ mục KHÔNG lặp mới "kêu ngay" khi giờ đã qua; mục lặp thì lần kế tiếp mới kêu (không giật mình vì thuốc 7 giờ sáng kêu lúc tối)
        await afterWrite(row.repeat_unit ? undefined : [`${row.id}|${row.start_local.slice(0, 10)}`]);
      } else {
        const before = dataRef.current.events.find((x) => x.id === eventId) ?? (await getEvent(sdk, eventId));
        if (!before) {
          setRoute({ name: 'notfound' });
          return;
        }
        if (scope === 'this' && occDate) {
          const occ = findOcc(eventId, occDate);
          if (occ) {
            const patch = thisOnlyPatch(form, occ, e);
            if (Object.keys(patch).length) await editThisOnly(sdk, eventId, occDate, patch);
            await afterWrite();
          }
        } else {
          const start = occDate && before.repeat_unit ? seriesStartDate(before, occDate, form) : form.date;
          const row = buildRow(form, eventId, before, e, start);
          await updateEvent(sdk, before, row);
          await afterWrite(row.repeat_unit ? undefined : [`${eventId}|${occDate ?? start}`]);
        }
      }
      setRoute({ name: 'main' });
      showToast({ msg: 'Đã lưu trên máy' });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const askDelete = (eventId: string, occ: Occurrence | null) => {
    const ev = dataRef.current.events.find((x) => x.id === eventId);
    if (!ev) return;
    const all = async () => {
      try {
        await removeEvent(sdk, eventId);
        setRoute({ name: 'main' });
        await afterWrite();
        showToast({ msg: 'Đã xoá' });
      } catch (e) {
        fail(e);
      }
    };
    if (ev.repeat_unit && occ) {
      setDialog({
        title: 'Xoá mục lặp',
        text: `“${ev.title}” lặp lại nhiều lần. Xoá lần nào?`,
        buttons: [
          {
            label: 'Chỉ lần này',
            run: () =>
              void (async () => {
                try {
                  await putOverride(sdk, eventId, occ.occDate, 'skip');
                  setRoute({ name: 'main' });
                  await afterWrite();
                  showToast({ msg: 'Đã xoá lần này' });
                } catch (e) {
                  fail(e);
                }
              })(),
          },
          { label: 'Tất cả các lần', run: () => void all(), danger: true },
          { label: 'Huỷ', run: () => undefined, secondary: true },
        ],
      });
    } else {
      setDialog({
        title: 'Xoá mục này?',
        text: `“${ev.title}” sẽ bị xoá và không nhắc nữa.`,
        buttons: [
          { label: 'Xoá', run: () => void all(), danger: true },
          { label: 'Huỷ', run: () => undefined, secondary: true },
        ],
      });
    }
  };

  const allowNotifications = async () => {
    const r = await reconcile(sdk, { env: env() }).catch(() => null);
    if (r && !r.denied) setDenied(false);
    else showToast({ msg: 'Vẫn chưa được phép. Nếu đã từ chối hai lần, bật thông báo cho Mina trong Cài đặt của máy. (PERMISSION_DENIED)', err: true });
  };

  // ---- dựng màn ----
  let view$;
  if (route.name === 'edit') {
    const ev = route.eventId ? data.events.find((e) => e.id === route.eventId) ?? null : null;
    const occ = ev && route.occDate ? findOcc(ev.id, route.occDate) : null;
    view$ = (
      <EditScreen
        key={`${route.eventId ?? 'new'}|${route.occDate ?? ''}|${route.kind}`}
        env={env()}
        event={ev}
        occ={occ}
        kind={route.kind}
        date={route.date}
        readOnly={readOnly}
        busy={busy}
        onCancel={() => setRoute(ev ? { name: 'detail', eventId: ev.id, occDate: route.occDate ?? ev.start_local.slice(0, 10) } : { name: 'main' })}
        onSave={(f, scope) => void save(f, scope, route.eventId, route.occDate)}
        onDelete={ev ? () => askDelete(ev.id, occ) : undefined}
      />
    );
  } else if (route.name === 'detail') {
    const ev = data.events.find((e) => e.id === route.eventId) ?? null;
    const occ = ev ? findOcc(route.eventId, route.occDate) : null;
    view$ = occ ? (
      <DetailScreen
        env={env()}
        occ={occ}
        readOnly={readOnly}
        noteMissing={noteMissing}
        onBack={() => setRoute({ name: 'main' })}
        onEdit={() => setRoute({ name: 'edit', eventId: occ.eventId, occDate: occ.occDate, kind: occ.kind, date: occ.dateLocal })}
        onDelete={() => askDelete(occ.eventId, occ)}
        onDone={() => void toggleDone(occ)}
        onSnooze={(until) => void snooze(occ, until)}
        onUnsnooze={() => void unsnooze(occ)}
        onOpenSource={() => occ.event.src_id && void openSource(occ.event.src_id)}
      />
    ) : loaded ? (
      <DetailScreen notFound onBack={() => setRoute({ name: 'main' })} />
    ) : null;
  } else if (route.name === 'notfound') {
    view$ = <DetailScreen notFound onBack={() => setRoute({ name: 'main' })} />;
  } else {
    view$ = (
      <MainScreen
        env={env()}
        loaded={loaded}
        events={data.events}
        overrides={data.overrides}
        readOnly={readOnly}
        denied={denied}
        resetN={resetN}
        view={view}
        setView={setView}
        selected={selected}
        setSelected={setSelected}
        onAllow={() => void allowNotifications()}
        onAdd={() => setAddSheet(true)}
        onOpen={(o) => {
          setNoteMissing(false);
          setRoute({ name: 'detail', eventId: o.eventId, occDate: o.occDate });
        }}
        onToggle={(o) => void toggleDone(o)}
      />
    );
  }
  return (
    <>
      {view$}
      {addSheet && (
        <Sheet title="Thêm gì?" onClose={() => setAddSheet(false)}>
          <button
            className="btn sec"
            onClick={() => {
              setAddSheet(false);
              setRoute({ name: 'edit', eventId: null, occDate: null, kind: 'event', date: selected });
            }}
          >
            Sự kiện
          </button>
          <button
            className="btn sec"
            onClick={() => {
              setAddSheet(false);
              setRoute({ name: 'edit', eventId: null, occDate: null, kind: 'reminder', date: selected });
            }}
          >
            Lời nhắc
          </button>
          <button className="btn sec" onClick={() => setAddSheet(false)}>
            Huỷ
          </button>
        </Sheet>
      )}
      <Toast toast={toast} onClose={closeToast} />
      {dialog && <Dialog {...dialog} onClose={() => setDialog(null)} />}
    </>
  );
}

