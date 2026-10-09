// S18 Nhắc tôi — sheet đáy (C24) với bộ chọn ngày–giờ (C27): nút nhanh, hai ô ngày/giờ, dòng tóm tắt, cảnh báo giờ đã qua.
import { useMemo, useRef, useState } from 'react';
import { defaultText, TITLE_MAX } from '../reminder/send';
import { formatSummary, isPast, joinAt, PAST_WARNING, quickOptions, splitAt } from '../reminder/time';
import { newId } from '../sdk';
import { Banner } from './kit';

export interface ReminderSubmit {
  /** Giữ nguyên giữa các lần bấm lại trong cùng một lần mở sheet — Lịch không tạo trùng. */
  id: string;
  text: string;
  at: string;
}

export function ReminderSheet({
  noteTitle,
  onSubmit,
  onClose,
}: {
  noteTitle: string;
  /** Trả chuỗi lỗi để hiện banner (rỗng = đã đặt xong, bên gọi đóng sheet); ném lỗi nếu thất bại khác. */
  onSubmit: (r: ReminderSubmit) => Promise<string>;
  onClose: () => void;
}) {
  const idRef = useRef(newId());
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [text, setText] = useState(defaultText(noteTitle));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const quick = useMemo(() => quickOptions(new Date()), []);
  const at = joinAt(date, time);
  const past = isPast(at);

  const pick = (q: string) => {
    const s = splitAt(q);
    setDate(s.date);
    setTime(s.time);
    setErr('');
  };
  const submit = async () => {
    if (busy || !at) return;
    setBusy(true);
    setErr('');
    try {
      const m = await onSubmit({ id: idRef.current, text: text.trim() || defaultText(noteTitle), at });
      if (m) setErr(m);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label="Nhắc tôi về ghi chú này">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>Nhắc tôi về ghi chú này</h3>
        {err && <Banner tone="err">{err}</Banner>}
        <div className="tags">
          {quick.map((q) => (
            <button key={q.key} className={`tagchip${q.at === at ? ' on' : ''}`} onClick={() => pick(q.at)}>
              {q.label}
            </button>
          ))}
        </div>
        <div>
          <div className="two">
            <input className="input" type="date" value={date} aria-label="Ngày nhắc" onChange={(e) => (setDate(e.target.value), setErr(''))} />
            <input className="input" type="time" value={time} aria-label="Giờ nhắc" onChange={(e) => (setTime(e.target.value), setErr(''))} />
          </div>
          <div className="muted sum" role="status">{formatSummary(date, time)}</div>
          {past && <div className="warntxt" role="alert">{PAST_WARNING}</div>}
        </div>
        <div>
          <span className="lbl">Nội dung nhắc</span>
          <input
            className="input"
            value={text}
            maxLength={TITLE_MAX}
            autoComplete="off"
            aria-label="Nội dung nhắc"
            onChange={(e) => setText(e.target.value)}
            onFocus={(e) => {
              const el = e.currentTarget;
              setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
            }}
          />
        </div>
        <div className="row">
          <button className="btn sec" onClick={onClose}>Huỷ</button>
          <button className={`btn${busy ? ' busy' : ''}`} disabled={busy || !at} onClick={() => void submit()}>
            {busy ? 'Đang đặt…' : 'Đặt nhắc'}
          </button>
        </div>
      </div>
    </div>
  );
}
