// S15 — Lịch (ngày / tuần): lưới tuần C25 kèm ngày âm, danh sách mục C26, nút "+ Thêm".
import { useMemo } from 'react';
import { addDays, mondayOf, WEEKDAY_SHORT, type Ymd } from '../recur/dates';
import type { EventRow, OverrideRow } from '../recur/model';
import { occurrencesAll, repeatSummary, type Env, type Occurrence } from '../recur/occurrences';
import { dayHeading, lunarCell, lunarMonthLine, monthTitle, timeOf, weekDays } from './format';
import { Banner, Empty, Seg, Skeleton } from './kit';

export interface MainProps {
  env: Env;
  loaded: boolean;
  events: EventRow[];
  overrides: OverrideRow[];
  readOnly: boolean;
  denied: boolean;
  resetN: number;
  view: 'day' | 'week';
  setView: (v: 'day' | 'week') => void;
  selected: Ymd;
  setSelected: (d: Ymd) => void;
  onAllow: () => void;
  onAdd: () => void;
  onOpen: (o: Occurrence) => void;
  onToggle: (o: Occurrence) => void;
}

export function MainScreen(p: MainProps) {
  const today = p.env.zone.msToLocal(p.env.now).slice(0, 10);
  const monday = mondayOf(p.selected);
  const days = weekDays(monday);
  const sunday = days[6];
  const occ = useMemo(() => occurrencesAll(p.events, p.overrides, monday, sunday, p.env), [p.events, p.overrides, monday, sunday, p.env.now > 0 ? Math.floor(p.env.now / 60_000) : 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const dots = new Set(occ.map((o) => o.dateLocal));
  const step = p.view === 'day' ? 1 : 7;
  const shown = p.view === 'day' ? occ.filter((o) => o.dateLocal === p.selected) : occ;

  const groups: { date: Ymd; items: Occurrence[] }[] = [];
  if (p.view === 'week') for (const d of days) { const items = occ.filter((o) => o.dateLocal === d); if (items.length) groups.push({ date: d, items }); }

  return (
    <div className="screen">
      <div className="bar">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="title" style={{ margin: 0 }}>{monthTitle(p.view === 'day' ? p.selected : days[3])}</h1>
          <div className="muted">{p.view === 'day' ? lunarMonthLine(p.selected, p.selected) : lunarMonthLine(monday, sunday)}</div>
        </div>
        <button className="btn sec slim" onClick={() => p.setSelected(today)}>
          Hôm nay
        </button>
      </div>
      <div className="body">
        {p.readOnly && <Banner tone="warn">Tài khoản đang ở chế độ chỉ đọc — xem được, chưa thêm hoặc sửa được. (READ_ONLY)</Banner>}
        {p.denied && (
          <Banner tone="err" action={{ label: 'Cho phép', run: p.onAllow }}>
            Chưa cho phép thông báo — lời nhắc sẽ không kêu. (PERMISSION_DENIED)
          </Banner>
        )}
        {!p.denied && p.resetN > 0 && <Banner tone="info">Đã đặt lại {p.resetN} thông báo.</Banner>}
        <div className="ctrl">
          <Seg
            value={p.view}
            options={[
              { v: 'day', label: 'Ngày' },
              { v: 'week', label: 'Tuần' },
            ]}
            onChange={p.setView}
          />
          <div className="calhead">
            <button className="iconbtn" aria-label={p.view === 'day' ? 'Ngày trước' : 'Tuần trước'} onClick={() => p.setSelected(addDays(p.selected, -step))}>
              ‹
            </button>
            <button className="iconbtn" aria-label={p.view === 'day' ? 'Ngày sau' : 'Tuần sau'} onClick={() => p.setSelected(addDays(p.selected, step))}>
              ›
            </button>
          </div>
        </div>
        <div className="wgrid" role="grid" aria-label="Tuần">
          {WEEKDAY_SHORT.slice(1).concat(WEEKDAY_SHORT[0]).map((w) => (
            <div key={w} className="wdl" role="columnheader">
              {w}
            </div>
          ))}
          {days.map((d) => {
            const lc = lunarCell(d);
            const cls = `cell${d === p.selected ? ' sel' : ''}${d === today ? ' today' : ''}`;
            return (
              <button key={d} role="gridcell" className={cls} aria-pressed={d === p.selected} aria-label={dayHeading(d)} onClick={() => p.setSelected(d)}>
                <b>{Number(d.slice(8, 10))}</b>
                <small className={lc.hl ? 'hl' : ''}>{lc.label}</small>
                <span className={`pt${dots.has(d) ? '' : ' none'}`} />
              </button>
            );
          })}
        </div>

        {!p.loaded ? (
          <Skeleton />
        ) : p.events.length === 0 ? (
          <Empty glyph="◷" action={p.readOnly ? undefined : { label: 'Thêm', run: p.onAdd }}>
            Chưa có lời nhắc nào
          </Empty>
        ) : p.view === 'day' ? (
          shown.length === 0 ? (
            <Empty glyph="◷" action={p.readOnly ? undefined : { label: 'Thêm', run: p.onAdd }}>
              Không có gì trong ngày này
            </Empty>
          ) : (
            <div className="list">{shown.map((o) => <Row key={o.key} o={o} env={p.env} readOnly={p.readOnly} onOpen={p.onOpen} onToggle={p.onToggle} />)}</div>
          )
        ) : groups.length === 0 ? (
          <Empty glyph="◷" action={p.readOnly ? undefined : { label: 'Thêm', run: p.onAdd }}>
            Không có gì trong tuần này
          </Empty>
        ) : (
          groups.map((g) => (
            <section key={g.date}>
              <h2 className="group">{dayHeading(g.date)}</h2>
              <div className="list">{g.items.map((o) => <Row key={o.key} o={o} env={p.env} readOnly={p.readOnly} onOpen={p.onOpen} onToggle={p.onToggle} />)}</div>
            </section>
          ))
        )}
      </div>
      <div className="footer">
        <button className="btn" disabled={p.readOnly} onClick={p.onAdd}>
          + Thêm
        </button>
      </div>
    </div>
  );
}

export function Row({ o, env, readOnly, onOpen, onToggle }: { o: Occurrence; env: Env; readOnly: boolean; onOpen: (o: Occurrence) => void; onToggle: (o: Occurrence) => void }) {
  const overdue = o.kind === 'reminder' && !o.done && !o.allDay && (o.snoozeUntilMs ?? o.startMs) < env.now;
  const reminder = o.kind === 'reminder';
  return (
    <div className={`crow${o.done ? ' done' : ''}`}>
      <button className="crow-main" onClick={() => onOpen(o)} aria-label={`${o.title}, mở chi tiết`}>
        <span className="tcol">
          {o.allDay ? <span>Cả ngày</span> : <span className={overdue ? 'warn' : ''}>{timeOf(o.startLocal)}</span>}
          {!o.allDay && o.endLocal && <small>{timeOf(o.endLocal)}</small>}
        </span>
        <span className="mid">
          <span className="ttl">{o.title}</span>
          <span className="subs">
            {o.recurring && <span className="tagchip mini">{repeatSummary(o.event)}</span>}
            {o.event.src_app === 'vn.app.note' && <span className="tagchip mini">Từ ghi chú</span>}
            {o.snoozeUntilMs !== null && !o.done && <span className="snz">Hoãn đến {timeOf(env.zone.msToLocal(o.snoozeUntilMs))}</span>}
            {o.done && o.doneAtMs && <span className="muted">Đã xong</span>}
          </span>
        </span>
      </button>
      {reminder && (
        <button className="tick" disabled={readOnly} role="checkbox" aria-checked={o.done} aria-label={o.done ? `Bỏ đánh dấu xong ${o.title}` : `Đánh dấu xong ${o.title}`} onClick={() => onToggle(o)}>
          <span className="box">{o.done ? '✓' : ''}</span>
        </button>
      )}
    </div>
  );
}

