// Khối giao diện dùng chung của Lịch (DESIGN-SYSTEM.md §4: C8 banner, C9 hộp thoại, C10 toast, C13 khuôn, C24 sheet).
import { useEffect, useRef, type ReactNode } from 'react';
import { errCode } from '../sdk';

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

export function Seg<T extends string>({ value, options, onChange, wide, disabled }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; wide?: boolean; disabled?: boolean }) {
  return (
    <div className={`seg${wide ? ' wide' : ''}`} role="group">
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
