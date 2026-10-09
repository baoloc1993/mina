// Sheet C24 của Đọc báo: S22 Thêm nguồn · S23 Hành động bài · sheet nguồn (đổi tên / thử lại / cho phép lại).
import { useState } from 'react';
import type { ItemRow, SourceGroup } from '../data/repo';
import { MAX_SOURCES } from '../data/repo';
import { AppError, unpackError } from '../sources/refresh';
import { quickTimes } from '../time';
import { isAdded, type Suggestion } from './model';
import { Sheet } from './kit';

// ---------------------------------------------------------------- S22
export function AddSheet({
  suggestions, groups, readOnly, busyKey, error, onAddSuggestion, onAddUrl, onClose,
}: {
  suggestions: Suggestion[];
  groups: SourceGroup[];
  readOnly: boolean;
  /** `key` gợi ý đang thêm, hoặc 'url' khi đang thêm từ ô dán. */
  busyKey: string | null;
  error: AppError | null;
  onAddSuggestion: (s: Suggestion) => void;
  onAddUrl: (raw: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');
  const busy = busyKey !== null;
  const full = groups.length >= MAX_SOURCES;
  return (
    <Sheet title="Thêm nguồn" onClose={onClose}>
      {readOnly && <div className="banner warn" role="alert"><span>Chỉ đọc — không thêm được nguồn (READ_ONLY)</span></div>}
      {suggestions.length > 0 && (
        <>
          <p className="heading">Báo gợi ý (từ máy chủ — không cần cho phép thêm)</p>
          <div className="list">
            {suggestions.map((s) => {
              const added = isAdded(s, groups);
              return (
                <div className="srow" key={s.key}>
                  <div className="mid" style={{ cursor: 'default' }}>
                    <span className="nm">{s.name}</span>
                    <span className="sub">{s.host}</span>
                  </div>
                  {added ? (
                    <span className="muted">Đã thêm</span>
                  ) : (
                    <button className={`btn slim sec${busyKey === s.key ? ' busy' : ''}`} disabled={busy || readOnly || full} onClick={() => onAddSuggestion(s)} aria-label={`Thêm ${s.name}`}>
                      {busyKey === s.key ? 'Đang thêm…' : 'Thêm'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      <div className="fld">
        <label className="lbl" htmlFor="feed-url">
          Hoặc dán địa chỉ RSS / Atom
        </label>
        <input
          id="feed-url"
          className={`input${error && busyKey === null && error.code !== 'NET_BLOCKED' ? ' err' : ''}`}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://blog.example.com/rss.xml"
          value={url}
          disabled={busy || readOnly}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && url.trim() && !busy && onAddUrl(url)}
        />
        <div className="muted" style={{ marginTop: 'var(--space-xs)' }}>
          Trang mới sẽ hỏi bạn cho phép Đọc báo truy cập trước khi tải
        </div>
        {error && (
          <div className="errtxt" role="alert">
            {error.message} ({error.code})
          </div>
        )}
      </div>
      {full && <div className="warntxt">Đã đủ {MAX_SOURCES} nguồn — bỏ bớt một nguồn để thêm.</div>}
      <button className={`btn${busyKey === 'url' ? ' busy' : ''}`} disabled={busy || readOnly || full || !url.trim()} onClick={() => onAddUrl(url)}>
        {busyKey === 'url' ? 'Đang tải…' : 'Thêm nguồn'}
      </button>
      <button className="btn sec" onClick={onClose}>
        Đóng
      </button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- S23
export function ItemSheet({
  item, sourceName, readOnly, busy, noteMissing, calendarMissing, now, onOpen, onToggleSaved, onNote, onRemind, onToggleRead, onClose,
}: {
  item: ItemRow;
  sourceName: string;
  readOnly: boolean;
  busy: 'note' | 'remind' | null;
  noteMissing: boolean;
  calendarMissing: boolean;
  now: number;
  onOpen: () => void;
  onToggleSaved: () => void;
  onNote: () => void;
  onRemind: (at: string) => void;
  onToggleRead: () => void;
  onClose: () => void;
}) {
  const [remind, setRemind] = useState(false);
  const saved = item.saved_at_ms !== null;
  const hasNote = item.note_id !== null;
  return (
    <Sheet title={item.title} onClose={onClose}>
      <div className="muted">{sourceName}</div>
      <button className="lnk" onClick={onOpen}>
        <span>Mở bài</span>
        <span className="val">↗</span>
      </button>
      <button className="lnk" disabled={readOnly} onClick={onToggleSaved}>
        <span>{saved ? 'Bỏ lưu đọc sau' : 'Đọc sau'}</span>
        <span className="val">{saved ? '★' : '☆'}</span>
      </button>
      <button className="lnk" disabled={readOnly || busy === 'note'} onClick={onNote}>
        <span>{hasNote ? 'Đã lưu thành note · Mở' : busy === 'note' ? 'Đang gửi…' : 'Lưu thành note → Ghi chú'}</span>
        <span className="val">{hasNote ? '↗' : '›'}</span>
      </button>
      {noteMissing && <div className="warntxt" role="alert">Chưa cài Ghi chú — mở Catalog để cài (INTENT_NO_HANDLER)</div>}
      <button className="lnk" disabled={readOnly || busy === 'remind'} onClick={() => setRemind((v) => !v)} aria-expanded={remind}>
        <span>{busy === 'remind' ? 'Đang gửi…' : 'Nhắc đọc → Lịch'}</span>
        <span className="val">{remind ? '▾' : '›'}</span>
      </button>
      {remind && (
        <>
          <div className="quick">
            {quickTimes(now).map((q) => (
              <button key={q.key} className="btn sec slim" disabled={readOnly || busy === 'remind'} onClick={() => onRemind(q.at)} title={q.text}>
                {q.label}
              </button>
            ))}
          </div>
          <div className="muted">Bài sẽ tự được lưu Đọc sau để mở được cả khi mất mạng.</div>
        </>
      )}
      {calendarMissing && <div className="warntxt" role="alert">Chưa cài Lịch — mở Catalog để cài (INTENT_NO_HANDLER)</div>}
      <button className="lnk" disabled={readOnly} onClick={onToggleRead}>
        <span>{item.read_at_ms !== null ? 'Đánh dấu chưa đọc' : 'Đánh dấu đã đọc'}</span>
        <span className="val">{item.read_at_ms !== null ? '○' : '●'}</span>
      </button>
      {readOnly && <div className="muted">Chỉ đọc — chỉ mở bài được (READ_ONLY)</div>}
      <button className="btn sec" onClick={onClose}>
        Đóng
      </button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- sheet nguồn
export function SourceSheet({
  group, readOnly, busy, onRename, onRetry, onAllow, onClose,
}: {
  group: SourceGroup;
  readOnly: boolean;
  busy: boolean;
  onRename: (name: string) => void;
  onRetry: () => void;
  onAllow: () => void;
  onClose: () => void;
}) {
  const src = group.main;
  const [name, setName] = useState(src.name);
  const err = unpackError(src.last_error);
  const blocked = err?.code === 'NET_BLOCKED';
  const dirty = name.trim() !== src.name && name.trim().length > 0;
  return (
    <Sheet title={src.name} onClose={onClose}>
      <div className="muted">{src.feed_url}</div>
      {err && (
        <div className="warntxt" role="alert">
          {err.message} ({err.code})
        </div>
      )}
      <div className="fld">
        <label className="lbl" htmlFor="src-name">
          Tên nguồn
        </label>
        <input id="src-name" className="input" value={name} maxLength={100} disabled={readOnly} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && dirty && onRename(name.trim())} />
      </div>
      <button className="btn" disabled={readOnly || !dirty} onClick={() => onRename(name.trim())}>
        Lưu tên
      </button>
      {blocked ? (
        <button className="btn sec" disabled={busy} onClick={onAllow}>
          Cho phép truy cập {src.host}
        </button>
      ) : (
        <button className={`btn sec${busy ? ' busy' : ''}`} disabled={busy || readOnly} onClick={onRetry}>
          {busy ? 'Đang tải…' : 'Tải lại nguồn này'}
        </button>
      )}
      <button className="btn sec" onClick={onClose}>
        Đóng
      </button>
    </Sheet>
  );
}
