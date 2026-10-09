// Khối giao diện dùng chung của Ghi chú (DESIGN-SYSTEM.md §4: C8 banner, C9 hộp thoại, C10 toast, C13 khuôn, C18 chip, C24 sheet).
import { useEffect, useRef, type ReactNode } from 'react';
import { highlightParts } from '../search/normalize';
import { errCode } from '../sdk';

export const IconSearch = () => (
  <svg className="ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </svg>
);

export const IconPin = () => (
  <svg className="pin" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Đã ghim">
    <path d="M14 3l7 7-3 1-3 3 1 5-2 2-4-6-6 6-1-1 6-6-6-4 2-2 5 1 3-3z" />
  </svg>
);

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

export function Empty({ glyph = '▤', tone, children, action }: { glyph?: string; tone?: 'err'; children: ReactNode; action?: { label: string; run: () => void; secondary?: boolean } }) {
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

export function TagChip({ label, on, onClick, onRemove, mini }: { label: string; on?: boolean; onClick?: () => void; onRemove?: () => void; mini?: boolean }) {
  const cls = `tagchip${on ? ' on' : ''}${mini ? ' mini' : ''}`;
  if (onClick) return <button className={cls} onClick={onClick}>{label}</button>;
  return (
    <span className={cls}>
      {label}
      {onRemove && (
        <button className="rm" aria-label={`Gỡ tag ${label}`} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}

export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

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
    if (toast) timer.current = setTimeout(onClose, toast.label ? 8000 : 4000); // có nút hành động (Hoàn tác) thì giữ lâu hơn cho người chậm tay
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

export function Dialog({ title, text, buttons, onClose }: { title: string; text: string; buttons: { label: string; run: () => void; secondary?: boolean }[]; onClose: () => void }) {
  return (
    <div className="scrim mid" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog">
        <h3>{title}</h3>
        <div className="muted" style={{ fontSize: 'var(--text-base)' }}>{text}</div>
        <div className="row">
          {buttons.map((b) => (
            <button
              key={b.label}
              className={`btn${b.secondary ? ' sec' : ''}`}
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

/** Câu tiếng Việt cho mã lỗi SDK (kèm mã trong ngoặc để P4 tra) — luôn có dấu, giọng trung tính. */
export function friendly(e: unknown, ctx: 'image' | 'file' | 'write' = 'write'): string {
  const code = errCode(e);
  switch (code) {
    case 'READ_ONLY':
      return 'Tài khoản đang ở chế độ chỉ đọc — cần mạng để xác minh lại. (READ_ONLY)';
    case 'PERMISSION_DENIED':
      return 'Chưa có quyền xem ảnh. Bật lại trong Cài đặt của máy. (PERMISSION_DENIED)';
    case 'INVALID_REQUEST':
      return ctx === 'file' ? 'Chỉ đính được tệp PDF nhỏ hơn 50 MB. (INVALID_REQUEST)' : 'Dữ liệu không hợp lệ. (INVALID_REQUEST)';
    case 'OFFLINE':
      return 'Cần có mạng cho việc này. (OFFLINE)';
    case 'SCOPE_DENIED':
      return 'Ghi chú chưa được cấp quyền cho việc này. (SCOPE_DENIED)';
    case 'NOT_FOUND':
      return 'Không tìm thấy. (NOT_FOUND)';
    default:
      return `Có lỗi xảy ra${code ? ` (${code})` : ''}. Thử lại sau.`;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
/** "Hôm nay 09:12" · "Hôm qua" · "Thứ Hai" (trong tuần) · "03/10" (xa hơn). `now` để test được. */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86_400_000);
  const diff = day(now) - day(d);
  if (diff <= 0) return `Hôm nay ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 1) return 'Hôm qua';
  if (diff < 7) return ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'][d.getDay()];
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

/** Ô chọn ngày hiển thị dd/mm/yyyy theo kiểu Việt Nam bất kể locale máy (ô date gốc nằm phủ trong suốt để vẫn mở bộ chọn của hệ thống). */
export function DateField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return (
    <label className="pickfield">
      <span>{ok ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : 'Chọn ngày'}</span>
      <input className="pf-native" type="date" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Ô chọn giờ hiển thị HH:mm (24 giờ) bất kể locale máy. */
export function TimeField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const ok = /^\d{2}:\d{2}$/.test(value);
  return (
    <label className="pickfield">
      <span>{ok ? value : 'Chọn giờ'}</span>
      <input className="pf-native" type="time" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
