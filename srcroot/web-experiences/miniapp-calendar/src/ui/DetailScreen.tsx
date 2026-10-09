// S17 — Chi tiết mục: tiêu đề, giờ (dương + âm), lặp, nhắc trước, nguồn (chip → note.open), Xong / Hoãn / Sửa / Xoá.
import { useState } from 'react';
import { ALERT_LABEL } from '../recur/model';
import { repeatSummary, type Env, type Occurrence } from '../recur/occurrences';
import { dmy, lunarOfYmd, timeOf } from './format';
import { snoozeOptions, whenText } from './form';
import { Banner, Empty, Sheet } from './kit';
import { lunarText } from '../lunar/lunar';
import { dayShort } from './format';

interface Props {
  notFound?: boolean;
  env?: Env;
  occ?: Occurrence;
  readOnly?: boolean;
  noteMissing?: boolean;
  onBack: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onDone?: () => void;
  onSnooze?: (until: string) => void;
  onUnsnooze?: () => void;
  onOpenSource?: () => void;
}

export function DetailScreen(p: Props) {
  const [snoozing, setSnoozing] = useState(false);
  if (p.notFound || !p.occ || !p.env) {
    return (
      <div className="screen">
        <div className="bar">
          <button className="iconbtn" aria-label="Quay lại" onClick={p.onBack}>←</button>
          <h1 className="title small">Chi tiết</h1>
        </div>
        <div className="body">
          <Empty tone="err" glyph="⚠" action={{ label: 'Về lịch', run: p.onBack, secondary: true }}>
            Không tìm thấy mục này. (NOT_FOUND)
          </Empty>
        </div>
      </div>
    );
  }
  const { occ, env } = p;
  const ro = !!p.readOnly;
  const l = lunarOfYmd(occ.dateLocal);
  const when = occ.allDay
    ? `${dayShort(occ.dateLocal)}/${occ.dateLocal.slice(0, 4)} · cả ngày`
    : `${dayShort(occ.dateLocal)}/${occ.dateLocal.slice(0, 4)} · ${timeOf(occ.startLocal)}${occ.endLocal ? `–${timeOf(occ.endLocal)}` : ''}`;
  const reminder = occ.kind === 'reminder';
  const startL = lunarOfYmd(occ.event.start_local.slice(0, 10));
  const leapStart = occ.event.repeat_cal === 'lunar' && occ.event.repeat_unit === 'year' && !!startL?.leap;
  const src = occ.event.src_app;
  const isNote = src === 'vn.app.note';
  const doneAt = occ.doneAtMs ? timeOf(env.zone.msToLocal(occ.doneAtMs)) : '';
  return (
    <div className="screen">
      <div className="bar">
        <button className="iconbtn" aria-label="Quay lại" onClick={p.onBack}>←</button>
        <h1 className="title small">Chi tiết</h1>
      </div>
      <div className="body">
        {ro && <Banner tone="warn">Tài khoản đang ở chế độ chỉ đọc — chưa sửa được. (READ_ONLY)</Banner>}
        {p.noteMissing && <Banner tone="warn">Cài Ghi chú để mở nguồn. (INTENT_NO_HANDLER)</Banner>}
        <h2 className="big-ttl">{occ.title}</h2>
        <div className="kv">
          <span className="heading">Thời gian</span>
          <span className="v">{when}</span>
          {l && <span className="muted">{lunarText(l)}</span>}
          {occ.snoozeUntilMs !== null && !occ.done && <span className="snz">Hoãn đến {whenText(occ.snoozeUntilMs, env)}</span>}
        </div>
        <div className="kv">
          <span className="heading">Lặp</span>
          <span className="v">{repeatSummary(occ.event)}</span>
          {leapStart && <span className="muted">Đặt trong tháng nhuận: các năm sau nhắc ở tháng thường cùng ngày.</span>}
        </div>
        <div className="kv">
          <span className="heading">Nhắc trước</span>
          <span className="v">{ALERT_LABEL[occ.alertMin] ?? `${occ.alertMin} phút trước`}</span>
        </div>
        {src && (
          <div className="kv">
            <span className="heading">Nguồn</span>
            {isNote ? (
              <button className="srcchip" onClick={p.onOpenSource}>
                Từ ghi chú · Mở
              </button>
            ) : (
              <span className="v">Từ {src}</span>
            )}
          </div>
        )}
        {reminder && occ.done && (
          <div className="kv">
            <span className="v">Đã xong{doneAt ? ` lúc ${doneAt}` : ''}</span>
            <button className="btn sec" disabled={ro} onClick={p.onDone}>
              Bỏ đánh dấu
            </button>
          </div>
        )}
        {reminder && !occ.done && (
          <div className="row">
            <button className="btn" disabled={ro} onClick={p.onDone}>
              Đánh dấu xong
            </button>
            <button className="btn sec" disabled={ro} onClick={() => (occ.snoozeUntilMs !== null ? p.onUnsnooze?.() : setSnoozing(true))}>
              {occ.snoozeUntilMs !== null ? 'Bỏ hoãn' : 'Hoãn'}
            </button>
          </div>
        )}
      </div>
      <div className="footer">
        <div className="row">
          <button className="btn sec" disabled={ro} onClick={p.onEdit}>
            Sửa
          </button>
          <button className="btn sec danger-text" disabled={ro} onClick={p.onDelete}>
            Xoá
          </button>
        </div>
      </div>
      {snoozing && (
        <Sheet title="Hoãn đến…" onClose={() => setSnoozing(false)}>
          {snoozeOptions(env).map((o) => (
            <button
              key={o.label}
              className="btn sec"
              onClick={() => {
                setSnoozing(false);
                p.onSnooze?.(o.until);
              }}
            >
              {o.label} (đến {whenText(env.zone.localToMs(o.until), env)})
            </button>
          ))}
          <button className="btn sec" onClick={() => setSnoozing(false)}>
            Huỷ
          </button>
        </Sheet>
      )}
    </div>
  );
}

void dmy;
