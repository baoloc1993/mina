// Khối giao diện dùng chung của Lịch (DESIGN-SYSTEM.md §4: C8 banner, C9 hộp thoại, C10 toast, C13 khuôn, C24 sheet).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { errCode } from '../sdk';

const p2 = (n: number) => String(n).padStart(2, '0');
// Ô chọn ngày / giờ bằng <select> (danh sách của hệ điều hành): chạy được trên MỌI WebView Android, giờ 24 h, tiếng Việt.
// Bản cũ phủ một <input type="date|time"> trong suốt để mở bộ chọn gốc — trên một số máy/WebView chạm không mở gì (dogfood vòng 7,
// máy thật của chủ dự án: "chọn ngày, chọn giờ không được") và bộ chọn gốc là AM/PM tiếng Anh, màu teal ngoài token.
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();

/** Thuần: tách "YYYY-MM-DD" → {y, m, d} (0 = chưa chọn). */
export function parseDate(v: string): { y: number; m: number; d: number } {
  const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return x ? { y: +x[1], m: +x[2], d: +x[3] } : { y: 0, m: 0, d: 0 };
}
/** Thuần: ghép lại; thiếu phần nào → '' (chưa đủ); ngày vượt số ngày của tháng thì kẹp (31/02 → 28/29). */
export function joinDate(y: number, m: number, d: number): string {
  if (!y || !m || !d) return '';
  return `${y}-${p2(m)}-${p2(Math.min(d, daysIn(y, m)))}`;
}
export function parseTime(v: string): { h: number; n: number } | null {
  const x = /^(\d{2}):(\d{2})$/.exec(v);
  return x ? { h: +x[1], n: +x[2] } : null;
}

type FieldProps = { value: string; onChange: (v: string) => void; label: string; error?: boolean; disabled?: boolean };

export function DateField({ value, onChange, label, error, disabled }: FieldProps) {
  const [part, setPart] = useState(parseDate(value));
  useEffect(() => setPart(parseDate(value)), [value]);
  const nowY = new Date().getFullYear();
  const years = range(Math.min(nowY - 1, part.y || nowY), Math.max(nowY + 8, part.y || nowY));
  const days = part.y && part.m ? daysIn(part.y, part.m) : 31;
  const set = (patch: Partial<{ y: number; m: number; d: number }>) => {
    const next = { ...part, ...patch };
    setPart(next);
    onChange(joinDate(next.y, next.m, next.d));
  };
  return (
    <div className={`pickfield${error ? ' err' : ''}${disabled ? ' off' : ''}`} role="group" aria-label={label}>
      <select className="pf-sel" aria-label={`${label} — ngày`} value={part.d || ''} disabled={disabled} onChange={(e) => set({ d: +e.target.value })}>
        <option value="">Ngày</option>
        {range(1, days).map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
      <span className="pf-sep" aria-hidden="true">/</span>
      <select className="pf-sel" aria-label={`${label} — tháng`} value={part.m || ''} disabled={disabled} onChange={(e) => set({ m: +e.target.value })}>
        <option value="">Tháng</option>
        {range(1, 12).map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <span className="pf-sep" aria-hidden="true">/</span>
      <select className="pf-sel pf-year" aria-label={`${label} — năm`} value={part.y || ''} disabled={disabled} onChange={(e) => set({ y: +e.target.value })}>
        <option value="">Năm</option>
        {years.map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>
    </div>
  );
}

/** Ô chọn giờ HH:mm (24 giờ). */
export function TimeField({ value, onChange, label, error, disabled }: FieldProps) {
  const [t, setT] = useState<{ h: number | null; n: number | null }>(() => {
    const x = parseTime(value);
    return x ? { h: x.h, n: x.n } : { h: null, n: null };
  });
  useEffect(() => {
    const x = parseTime(value);
    setT(x ? { h: x.h, n: x.n } : { h: null, n: null });
  }, [value]);
  const set = (patch: Partial<{ h: number | null; n: number | null }>) => {
    const next = { ...t, ...patch };
    setT(next);
    onChange(next.h !== null && next.n !== null ? `${p2(next.h)}:${p2(next.n)}` : '');
  };
  const num = (v: string) => (v === '' ? null : +v);
  return (
    <div className={`pickfield${error ? ' err' : ''}${disabled ? ' off' : ''}`} role="group" aria-label={label}>
      <select className="pf-sel" aria-label={`${label} — giờ`} value={t.h ?? ''} disabled={disabled} onChange={(e) => set({ h: num(e.target.value), n: t.n ?? 0 })}>
        <option value="">Giờ</option>
        {range(0, 23).map((h) => (
          <option key={h} value={h}>{p2(h)}</option>
        ))}
      </select>
      <span className="pf-sep" aria-hidden="true">:</span>
      <select className="pf-sel" aria-label={`${label} — phút`} value={t.n ?? ''} disabled={disabled} onChange={(e) => set({ n: num(e.target.value), h: t.h ?? new Date().getHours() })}>
        <option value="">Phút</option>
        {range(0, 59).map((n) => (
          <option key={n} value={n}>{p2(n)}</option>
        ))}
      </select>
    </div>
  );
}
void p2;

export function Banner({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'err'; children: ReactNode; action?: { label: string; run: () => void } }) {
  return (
    <div className={`banner ${tone}`} role={tone === 'info' ? 'status' : 'alert'}>
      <span>{children}</span>
      {action && (
        <button className="btn slim sec" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

export function Empty({ glyph = '▦', tone, children, action }: { glyph?: string; tone?: 'err'; children: ReactNode; action?: { label: string; run: () => void; secondary?: boolean } }) {
  return (
    <div className={`empty${tone ? ' ' + tone : ''}`}>
      <div className="big" aria-hidden="true">
        {glyph}
      </div>
      <div>{children}</div>
      {action && (
        <button className={`btn${action.secondary ? ' sec' : ''}`} onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

export const Skeleton = () => (
  <div className="skel" aria-busy="true" aria-label="Đang tải">
    <div />
    <div />
    <div />
  </div>
);

export interface ToastState {
  msg: string;
  err?: boolean;
  label?: string;
  run?: () => void;
}

export function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (toast) timer.current = setTimeout(onClose, toast.label ? 8000 : 4000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className={`toast${toast.err ? ' err' : ''}`} role={toast.err ? 'alert' : 'status'}>
      <span>{toast.msg}</span>
      {toast.label && (
        <button
          onClick={() => {
            onClose();
            toast.run?.();
          }}
        >
          {toast.label}
        </button>
      )}
    </div>
  );
}

export interface DialogButton {
  label: string;
  run: () => void;
  secondary?: boolean;
  danger?: boolean;
}

export function Dialog({ title, text, buttons, onClose }: { title: string; text: string; buttons: DialogButton[]; onClose: () => void }) {
  return (
    <div className="scrim mid" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog">
        <h3>{title}</h3>
        <div className="muted" style={{ fontSize: 'var(--text-base)' }}>{text}</div>
        <div className="col">
          {buttons.map((b) => (
            <button
              key={b.label}
              className={`btn${b.secondary ? ' sec' : ''}${b.danger ? ' danger' : ''}`}
              onClick={() => {
                onClose();
                b.run();
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function Switch({ on, label, hint, disabled, onChange }: { on: boolean; label: string; hint?: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className="swrow" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="tx">
        {label}
        {hint && <span className="muted" style={{ display: 'block' }}>{hint}</span>}
      </span>
      <span className={`sw${on ? ' on' : ''}`} aria-hidden="true" />
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange, wide, small, disabled }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; wide?: boolean; small?: boolean; disabled?: boolean }) {
  return (
    <div className={`seg${wide ? ' wide' : ''}${small ? ' small' : ''}`} role="group">
      {options.map((o) => (
        <button key={o.v} className={o.v === value ? 'on' : ''} aria-pressed={o.v === value} disabled={disabled} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Câu tiếng Việt cho mã lỗi SDK (kèm mã trong ngoặc để P4 tra) — luôn có dấu, giọng trung tính. */
export function friendly(e: unknown): string {
  const code = errCode(e);
  switch (code) {
    case 'READ_ONLY':
      return 'Tài khoản đang ở chế độ chỉ đọc — cần mạng để xác minh lại. (READ_ONLY)';
    case 'PERMISSION_DENIED':
      return 'Chưa cho phép thông báo — lời nhắc sẽ không kêu. (PERMISSION_DENIED)';
    case 'INVALID_REQUEST':
      return 'Dữ liệu không hợp lệ. (INVALID_REQUEST)';
    case 'OFFLINE':
      return 'Cần có mạng cho việc này. (OFFLINE)';
    case 'NOT_FOUND':
      return 'Không tìm thấy mục này. (NOT_FOUND)';
    case 'INTENT_NO_HANDLER':
      return 'Chưa cài Ghi chú để mở nguồn. (INTENT_NO_HANDLER)';
    case 'SCOPE_DENIED':
      return 'Lịch chưa được cấp quyền cho việc này. (SCOPE_DENIED)';
    default:
      return `Có lỗi xảy ra${code ? ` (${code})` : ''}. Thử lại sau.`;
  }
}
