// S11 Danh sách ghi chú + S13 Thùng rác. Bám PROTOTYPE.md §1: ô tìm → chip lọc tag → nhóm "Đã ghim" → các ghi chú → "Thùng rác (N)" → nút "Ghi chú mới".
import { useEffect, useState } from 'react';
import { loadText } from '../crdt/session';
import { daysLeft, type NoteRow } from '../data/repo';
import type { TagGroup } from '../data/tags';
import { excerptAround } from '../search/normalize';
import type { Sdk } from '../sdk';
import { Banner, Empty, formatWhen, Highlight, IconPin, IconSearch, Skeleton, TagChip } from './kit';

const excerptCache = new Map<string, string>();

function Row({ sdk, n, terms, tags }: { sdk: Sdk; n: NoteRow; terms: string[]; tags: TagGroup[] }) {
  const key = `${n.id}:${n.updated_at}:${terms.join(' ')}`;
  const [ex, setEx] = useState<string | null>(excerptCache.get(key) ?? null);
  useEffect(() => {
    if (!terms.length) return setEx(null);
    if (excerptCache.has(key)) return setEx(excerptCache.get(key)!);
    let alive = true;
    loadText(sdk, n.id)
      .then((t) => {
        const e = excerptAround(t, terms);
        if (excerptCache.size > 200) excerptCache.clear();
        excerptCache.set(key, e);
        if (alive) setEx(e);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sdk, key, terms, n.id]);
  const snippet = terms.length ? ex ?? n.snippet : n.snippet;
  return (
    <>
      <span className="ttl">{terms.length ? <Highlight text={n.title || 'Không có tiêu đề'} terms={terms} /> : n.title || 'Không có tiêu đề'}</span>
      {snippet && <span className="snip">{terms.length ? <Highlight text={snippet} terms={terms} /> : snippet}</span>}
      {tags.length > 0 && <span className="tags">{tags.map((g) => <TagChip key={g.key} mini label={g.name} />)}</span>}
    </>
  );
}

export interface ListProps {
  sdk: Sdk;
  ready: boolean;
  readOnly: boolean;
  notes: NoteRow[];
  groups: TagGroup[];
  tagMap: Map<string, TagGroup[]>;
  trashCount: number;
  q: string;
  terms: string[];
  setQ: (q: string) => void;
  tagFilter: string;
  setTagFilter: (k: string) => void;
  hasAny: boolean;
  creating: boolean;
  syncing: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onTrash: () => void;
}

export function ListScreen(p: ListProps) {
  const [searchFocus, setSearchFocus] = useState(false);
  const filtered = p.tagFilter ? p.notes.filter((n) => p.tagMap.get(n.id)?.some((g) => g.key === p.tagFilter)) : p.notes;
  const searching = p.terms.length > 0;
  const pinned = searching ? [] : filtered.filter((n) => n.pinned);
  const rest = searching ? filtered : filtered.filter((n) => !n.pinned);
  const item = (n: NoteRow) => (
    <button key={n.id} className="note" onClick={() => p.onOpen(n.id)}>
      <span className="t">
        <Row sdk={p.sdk} n={n} terms={p.terms} tags={p.tagMap.get(n.id) ?? []} />
      </span>
      <span className="side">
        {n.pinned ? <IconPin /> : null}
        <span className="when">{formatWhen(n.updated_at)}</span>
      </span>
    </button>
  );
  return (
    <div className="screen">
      <div className="bar">
        <h1 className="title">Ghi chú</h1>
      </div>
      <div className="body">
        {p.readOnly && <Banner tone="warn">Chỉ đọc — cần mạng để xác minh lại tài khoản. Chữ đã viết không mất.</Banner>}
        {p.syncing && <Banner>{p.syncing}</Banner>}
        <div className="search">
          <IconSearch />
          <input className="input" type="search" placeholder="Tìm ghi chú" aria-label="Tìm ghi chú" autoComplete="off" value={p.q} onFocus={() => setSearchFocus(true)} onBlur={() => setSearchFocus(false)} onChange={(e) => p.setQ(e.target.value)} />
          {p.q && (
            <button className="clr" aria-label="Xoá chữ tìm" onClick={() => p.setQ('')}>
              ×
            </button>
          )}
        </div>
        <div className="tags scroll">
          <TagChip label="Tất cả" on={!p.tagFilter} onClick={() => p.setTagFilter('')} />
          {p.groups.map((g) => (
            <TagChip key={g.key} label={g.name} on={p.tagFilter === g.key} onClick={() => p.setTagFilter(p.tagFilter === g.key ? '' : g.key)} />
          ))}
        </div>
        {!p.ready ? (
          <Skeleton />
        ) : !p.hasAny && !searching ? (
          <Empty>Chưa có ghi chú nào</Empty>
        ) : !filtered.length ? (
          <Empty glyph="?">
            Không có ghi chú nào khớp
            {searching && <div className="muted">Thử bớt từ khoá hoặc bỏ lọc tag. Không cần gõ dấu.</div>}
          </Empty>
        ) : (
          <>
            {pinned.length > 0 && (
              <div>
                <p className="group">Đã ghim</p>
                <div className="notes">{pinned.map(item)}</div>
              </div>
            )}
            {rest.length > 0 && (
              <div>
                {pinned.length > 0 && <p className="group">Ghi chú</p>}
                <div className="notes">{rest.map(item)}</div>
              </div>
            )}
          </>
        )}
        <button className="link" onClick={p.onTrash}>
          Thùng rác ({p.trashCount})
        </button>
      </div>
      <div className="footer" hidden={searchFocus /* đang gõ tìm: nhường chỗ cho kết quả khi bàn phím mở (dogfood mobile #6) */}>
        <button className={`btn${p.creating ? ' busy' : ''}`} disabled={p.readOnly || p.creating} onClick={p.onNew}>
          {p.creating ? 'Đang tạo…' : 'Ghi chú mới'}
        </button>
      </div>
    </div>
  );
}

export function TrashScreen({ trash, busyId, onBack, onOpen, onRestore }: { trash: NoteRow[]; busyId: string | null; onBack: () => void; onOpen: (id: string) => void; onRestore: (id: string) => void }) {
  return (
    <div className="screen">
      <div className="bar">
        <button className="iconbtn" aria-label="Quay lại" onClick={onBack}>
          ←
        </button>
        <h1 className="title small">Thùng rác</h1>
      </div>
      <div className="body">
        <p className="muted" style={{ margin: 0 }}>
          Ghi chú trong thùng rác tự xoá hẳn sau 30 ngày. Khôi phục để sửa lại.
        </p>
        {!trash.length ? (
          <Empty glyph="○">Thùng rác trống</Empty>
        ) : (
          <div className="notes">
            {trash.map((n) => {
              const left = daysLeft(Number(n.trashed_at_ms));
              return (
                <div key={n.id} className="note trash" role="button" tabIndex={0} onClick={() => onOpen(n.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(n.id)}>
                  <span className="t">
                    <span className="ttl">{n.title || 'Không có tiêu đề'}</span>
                    {n.snippet && <span className="snip">{n.snippet}</span>}
                  </span>
                  <span className="side">
                    <span className={`left${left <= 3 ? ' soon' : ''}`}>còn {left} ngày</span>
                    <button
                      className={`btn sec slim${busyId === n.id ? ' busy' : ''}`}
                      disabled={busyId === n.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRestore(n.id);
                      }}
                    >
                      Khôi phục
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
