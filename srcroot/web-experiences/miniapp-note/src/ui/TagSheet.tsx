// S14 Gắn tag — sheet đáy (C24): danh sách tag dùng chung (gồm tag do app khác tạo), ô tick, ô "Tạo tag mới".
import { useState } from 'react';
import type { TagGroup } from '../data/tags';

export function TagSheet({
  groups,
  selected,
  onToggle,
  onCreate,
  onClose,
}: {
  groups: TagGroup[];
  selected: Set<string>;
  onToggle: (g: TagGroup) => Promise<void>;
  /** Trả thông báo (vd "Đã có tag này — dùng lại") hoặc chuỗi rỗng khi tạo mới thành công; ném lỗi nếu thất bại. */
  onCreate: (name: string) => Promise<string>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!name.trim()) {
      setMsg('Nhập tên tag');
      return;
    }
    setBusy(true);
    try {
      setMsg(await onCreate(name));
      setName('');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label="Tag của ghi chú">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>Tag của ghi chú</h3>
        {!groups.length && <div className="muted">Chưa có tag nào — tạo tag đầu tiên</div>}
        {groups.map((g) => {
          const on = selected.has(g.key);
          return (
            <button key={g.key} className={`pick${on ? ' on' : ''}`} role="checkbox" aria-checked={on} onClick={() => void onToggle(g)}>
              <span className="box">{on ? '✓' : ''}</span>
              <span>{g.name}</span>
            </button>
          );
        })}
        <div>
          <input
            className={`input${msg && msg !== 'Đã có tag này — dùng lại' ? ' err' : ''}`}
            placeholder="Tạo tag mới"
            value={name}
            maxLength={100}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              setMsg('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          {msg && <div className={msg === 'Đã có tag này — dùng lại' ? 'muted' : 'errtxt'}>{msg}</div>}
        </div>
        <div className="row">
          <button className={`btn sec${busy ? ' busy' : ''}`} disabled={busy} onClick={() => void add()}>
            {busy ? 'Đang thêm…' : 'Thêm'}
          </button>
          <button className="btn" onClick={onClose}>
            Xong
          </button>
        </div>
      </div>
    </div>
  );
}
