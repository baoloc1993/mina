// S16 — Soạn sự kiện / lời nhắc (C27 chọn ngày–giờ, C28 chọn lặp trong sheet C24).
import { useState } from 'react';
import { ALERT_CHOICES, type EventRow, type Kind, type RepeatUnit } from '../recur/model';
import { repeatSummary, type Env, type Occurrence } from '../recur/occurrences';
import { solarToLunar } from '../lunar/lunar';
import { buildRow, defaultForm, formFromEvent, isPast, nextLunarDate, quickPicks, validate, type Form } from './form';
import { summaryLine } from './format';
import { Banner, DateField, Dialog, Seg, Sheet, Switch, TimeField } from './kit';

interface Props {
  env: Env;
  event: EventRow | null;
  occ: Occurrence | null;
  kind: Kind;
  date: string;
  readOnly: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (f: Form, scope: 'all' | 'this') => void;
  onDelete?: () => void;
}

const UNITS: { v: RepeatUnit | 'none'; label: string }[] = [
  { v: 'none', label: 'Không' },
  { v: 'day', label: 'Mỗi ngày' },
  { v: 'week', label: 'Mỗi tuần' },
  { v: 'month', label: 'Mỗi tháng' },
  { v: 'year', label: 'Mỗi năm' },
];

export function EditScreen(p: Props) {
  const [f, setF] = useState<Form>(() => (p.event ? formFromEvent(p.event, p.occ, p.env) : defaultForm(p.kind, p.date, p.env)));
  const [showErr, setShowErr] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [scopeAsk, setScopeAsk] = useState(false);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const errs = validate(f);
  const past = isPast(f, p.env);
  const editing = !!p.event;
  const ro = p.readOnly;

  const repeatChanged = (() => {
    if (!p.event) return false;
    const e = p.event;
    return (e.repeat_unit ?? null) !== f.unit || (f.unit !== null && (e.repeat_every !== f.every || e.repeat_cal !== f.cal || (e.repeat_until ?? '') !== f.until));
  })();

  const submit = () => {
    setShowErr(true);
    if (ro || p.busy) return;
    if (errs.every || errs.until) return setRepeatOpen(true); // lỗi nằm trong sheet Lặp — mở lại cho người dùng thấy
    if (Object.keys(errs).length) return;
    if (p.event?.repeat_unit && p.occ && !repeatChanged) setScopeAsk(true);
    else p.onSave(f, 'all');
  };

  const row = buildRow(f, 'x', null, p.env);
  const summary = repeatSummary(row);
  const picks = quickPicks(p.env);
  const repeatErr = showErr ? errs.every ?? errs.until : undefined;
  const occLabel = p.occ ? `${p.occ.occDate.slice(8, 10)}/${p.occ.occDate.slice(5, 7)}` : '';

  return (
    <div className="screen">
      <div className="bar">
        <button className="iconbtn txt" onClick={p.onCancel}>
          Huỷ
        </button>
        <h1 className="title small" style={{ textAlign: 'center' }}>{editing ? 'Sửa' : f.kind === 'event' ? 'Sự kiện mới' : 'Lời nhắc mới'}</h1>
        <button className="iconbtn txt" disabled={ro || p.busy} onClick={submit}>
          {p.busy ? 'Đang lưu…' : 'Lưu'}
        </button>
      </div>
      <div className="body">
        {ro && <Banner tone="warn">Tài khoản đang ở chế độ chỉ đọc — chưa lưu được. (READ_ONLY)</Banner>}
        {!editing && (
          <Seg
            wide
            value={f.kind}
            options={[
              { v: 'event', label: 'Sự kiện' },
              { v: 'reminder', label: 'Lời nhắc' },
            ]}
            onChange={(k) => set({ kind: k })}
          />
        )}
        <div className="fld">
          <label className="lbl" htmlFor="ttl">Tiêu đề</label>
          <input id="ttl" className={`input${showErr && errs.title ? ' err' : ''}`} value={f.title} maxLength={200} placeholder={f.kind === 'reminder' ? 'Việc cần làm?' : 'Sự kiện gì?'} onChange={(e) => set({ title: e.target.value })} />
          {showErr && errs.title && <div className="errtxt" role="alert">{errs.title} (INVALID_REQUEST)</div>}
        </div>
        <Switch on={f.allDay} label="Cả ngày" hint={f.allDay ? 'Nhắc lúc 07:00' : undefined} onChange={(v) => set({ allDay: v, fixed: v ? false : f.fixed })} />
        <div className="fld">
          <span className="lbl">{f.kind === 'event' ? 'Bắt đầu' : 'Nhắc lúc'}</span>
          <div className="two">
            <DateField label="Ngày" value={f.date} error={showErr && !!errs.date} onChange={(v) => set({ date: v })} />
            {!f.allDay && <TimeField label="Giờ" value={f.time} error={showErr && !!errs.time} onChange={(v) => set({ time: v })} />}
          </div>
          {!f.allDay && f.kind === 'event' && (
            <>
              <span className="lbl" style={{ marginTop: 'var(--space-sm)' }}>Kết thúc (cùng ngày)</span>
              <TimeField label="Giờ kết thúc" value={f.endTime} error={!!errs.end} onChange={(v) => set({ endTime: v })} />
            </>
          )}
          {errs.end && <div className="errtxt" role="alert">{errs.end}</div>}
          {past && <div className="warntxt">Giờ này đã qua — sẽ nhắc ngay.</div>}
          {errs.date === undefined && <div className="muted" style={{ marginTop: 'var(--space-xs)' }}>{summaryLine(f.date, f.allDay ? null : f.time)}</div>}
          {!f.allDay && !editing && (
            <div className="tags" style={{ marginTop: 'var(--space-sm)' }}>
              {picks.map((q) => (
                <button key={q.label} className="tagchip" onClick={() => set({ date: q.date, time: q.time, allDay: false })}>
                  {q.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="fld">
          <button className="lnk" onClick={() => setRepeatOpen(true)}>
            <span>Lặp</span>
            <span className="val">{summary}</span>
          </button>
          {repeatErr && <div className="errtxt" role="alert">{repeatErr}</div>}
        </div>
        <div className="fld">
          <span className="lbl">Nhắc trước</span>
          <Seg wide small value={String(f.alert)} options={ALERT_CHOICES.map((a) => ({ v: String(a), label: a === 0 ? 'Đúng giờ' : a === 10 ? '10 phút' : a === 60 ? '1 giờ' : '1 ngày' }))} onChange={(v) => set({ alert: Number(v) })} />
        </div>
        {!f.allDay && !(f.unit && f.cal === 'lunar' && f.unit !== 'day' && f.unit !== 'week') && (
          <Switch on={f.fixed} label="Giữ đúng thời điểm khi đổi múi giờ" hint="Dùng cho họp online. Mặc định, 7 giờ là 7 giờ nơi bạn đang ở." onChange={(v) => set({ fixed: v })} />
        )}
        {editing && p.onDelete && (
          <button className="btn sec danger-text" disabled={ro} onClick={p.onDelete}>
            Xoá
          </button>
        )}
      </div>
      {repeatOpen && <RepeatSheet f={f} errs={errs} set={set} onClose={() => setRepeatOpen(false)} summary={summary} env={p.env} />}
      {scopeAsk && (
        <Dialog
          title="Sửa mục lặp"
          text={`“${p.event?.title ?? ''}” lặp lại nhiều lần. Áp dụng cho lần nào${occLabel ? ` (đang sửa lần ngày ${occLabel})` : ''}?`}
          onClose={() => setScopeAsk(false)}
          buttons={[
            { label: occLabel ? `Chỉ lần ${occLabel}` : 'Chỉ lần này', run: () => p.onSave(f, 'this') },
            { label: 'Tất cả các lần', run: () => p.onSave(f, 'all'), secondary: true },
            { label: 'Huỷ', run: () => undefined, secondary: true },
          ]}
        />
      )}
    </div>
  );
}

function RepeatSheet({ f, errs, set, onClose, summary, env }: { f: Form; errs: { every?: string; until?: string }; set: (p: Partial<Form>) => void; onClose: () => void; summary: string; env: Env }) {
  const canLunar = f.unit === 'month' || f.unit === 'year';
  const today = env.zone.msToLocal(env.now).slice(0, 10);
  const lunar = f.cal === 'lunar' && canLunar;
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(f.date) && Number(f.date.slice(0, 4)) >= 1901 && Number(f.date.slice(0, 4)) <= 2099 ? solarToLunar(Number(f.date.slice(0, 4)), Number(f.date.slice(5, 7)), Number(f.date.slice(8, 10))) : null;
  const setLunar = (day: number, month: number | null) => {
    if (!Number.isInteger(day) || day < 1 || day > 30) return;
    const d = nextLunarDate(day, month, today);
    if (d) set({ date: d });
  };
  return (
    <Sheet title="Lặp" onClose={onClose}>
      <div className="col">
        {UNITS.map((u) => (
          <button
            key={u.v}
            className={`pick${(f.unit ?? 'none') === u.v ? ' on' : ''}`}
            aria-pressed={(f.unit ?? 'none') === u.v}
            onClick={() => set({ unit: u.v === 'none' ? null : u.v, cal: u.v === 'month' || u.v === 'year' ? f.cal : 'solar' })}
          >
            <span className="box" aria-hidden="true">{(f.unit ?? 'none') === u.v ? '✓' : ''}</span>
            {u.label}
          </button>
        ))}
      </div>
      {f.unit && (
        <>
          {canLunar && (
            <div className="fld">
              <span className="lbl">Theo lịch</span>
              <Seg wide value={f.cal} options={[{ v: 'solar', label: 'Dương lịch' }, { v: 'lunar', label: 'Âm lịch' }]} onChange={(c) => set({ cal: c, ...(c === 'lunar' ? { allDay: true, fixed: false } : {}) })} />
            </div>
          )}
          {lunar && anchor && (
            <div className="fld">
              <span className="lbl">{f.unit === 'year' ? 'Ngày âm lịch (vd giỗ 12 tháng 3)' : 'Ngày âm lịch mỗi tháng (vd rằm = 15)'}</span>
              <div className="two">
                <input className="input" type="number" inputMode="numeric" min={1} max={30} aria-label="Ngày âm" value={anchor.day} onChange={(e) => setLunar(Number(e.target.value), f.unit === 'year' ? anchor.month : null)} />
                {f.unit === 'year' && <input className="input" type="number" inputMode="numeric" min={1} max={12} aria-label="Tháng âm" value={anchor.month} onChange={(e) => { const m = Number(e.target.value); if (Number.isInteger(m) && m >= 1 && m <= 12) setLunar(anchor.day, m); }} />}
              </div>
              <span className="muted" style={{ marginTop: 'var(--space-xs)' }}>
                Lặp âm lịch là mục cả ngày, nhắc lúc 07:00. Lần đầu: {f.date.slice(8, 10)}/{f.date.slice(5, 7)}/{f.date.slice(0, 4)}. Năm có tháng nhuận chỉ nhắc ở tháng thường; ngày 30 gặp tháng thiếu thì nhắc ngày 29.
              </span>
            </div>
          )}
          <div className="fld">
            <label className="lbl" htmlFor="every">Mỗi (số {f.unit === 'day' ? 'ngày' : f.unit === 'week' ? 'tuần' : f.unit === 'month' ? 'tháng' : 'năm'})</label>
            <input id="every" className={`input${errs.every ? ' err' : ''}`} type="number" inputMode="numeric" min={1} max={365} value={Number.isFinite(f.every) ? f.every : ''} onChange={(e) => set({ every: e.target.value === '' ? NaN : Math.trunc(Number(e.target.value)) })} />
            {errs.every && <div className="errtxt" role="alert">{errs.every}</div>}
          </div>
          <div className="fld">
            <span className="lbl">Đến ngày (không bắt buộc)</span>
            <div className="row">
              <DateField label="Đến ngày" value={f.until} error={!!errs.until} onChange={(v) => set({ until: v })} />
              {f.until && (
                <button className="btn sec slim" onClick={() => set({ until: '' })}>
                  Bỏ
                </button>
              )}
            </div>
            {errs.until && <div className="errtxt" role="alert">{errs.until}</div>}
          </div>
        </>
      )}
      <div className="muted">{summary}</div>
      <div className="stick">
        <button className="btn" disabled={!!(errs.every || errs.until)} onClick={onClose}>
          Xong
        </button>
      </div>
    </Sheet>
  );
}
