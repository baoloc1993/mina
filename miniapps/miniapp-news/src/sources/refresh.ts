// Thêm nguồn và làm mới feed. Thuần logic trên `window.miniapp`.
import { NotFeedError, parseFeed } from '../feed/parse';
import { normalizeFeedUrl } from '../feed/url';
import { markSourceError, insertSourceWithItems, MAX_SOURCES, upsertItems, type SourceGroup, type SourceRow } from '../data/repo';
import { errCode, newId, type Sdk } from '../sdk';

const FETCH_TIMEOUT = 15_000;
const CONCURRENCY = 4;
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

/** Lỗi có mã hiển thị (mã nằm trong ngoặc ở UI, câu tiếng Việt ở `message`). */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Mã lỗi SDK / lỗi phân tích → câu tiếng Việt. `host` = host đang tải (để phân biệt redirect sang host khác). */
export function toAppError(e: unknown, host: string): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof NotFeedError) return new AppError('INVALID_REQUEST', 'Không phải RSS/Atom — dán đúng địa chỉ feed');
  const code = errCode(e);
  const detail = (e as { detail?: unknown } | null)?.detail;
  switch (code) {
    case 'NET_BLOCKED':
      return typeof detail === 'string' && detail && detail !== host.replace(/:\d+$/, '')
        ? new AppError('NET_BLOCKED', `Trang chuyển sang ${detail} — thêm lại bằng địa chỉ đó`)
        : new AppError('NET_BLOCKED', `Chưa được phép truy cập ${host} — bấm để cho phép lại`);
    case 'OFFLINE':
      return new AppError('OFFLINE', 'Không có mạng — kết nối rồi thử lại');
    case 'NET_ERROR':
      return new AppError('NET_ERROR', (e as Error).message || 'Không tải được trang');
    case 'READ_ONLY':
      return new AppError('READ_ONLY', 'Tài khoản đang ở chế độ chỉ đọc — cần mạng để xác minh lại');
    case 'SCOPE_DENIED':
      return new AppError('SCOPE_DENIED', 'Đọc báo chưa được cấp quyền cho việc này');
    default:
      return new AppError(code || 'INTERNAL', 'Có lỗi xảy ra. Thử lại sau');
  }
}

export const packError = (e: AppError) => `${e.code}|${e.message}`;
export function unpackError(raw: string | null): { code: string; message: string } | null {
  if (!raw) return null;
  const i = raw.indexOf('|');
  return i > 0 ? { code: raw.slice(0, i), message: raw.slice(i + 1) } : { code: 'NET_ERROR', message: raw };
}

async function download(sdk: Sdk, url: string, host: string, now: number) {
  let res;
  try {
    res = await sdk.net.fetch(url, { timeoutMs: FETCH_TIMEOUT, headers: { accept: ACCEPT } });
  } catch (e) {
    throw toAppError(e, host);
  }
  if (res.status < 200 || res.status >= 300) throw new AppError('NET_ERROR', `Trang trả về ${res.status}`);
  try {
    return parseFeed(res.body, now);
  } catch (e) {
    throw toAppError(e, host);
  }
}

export type AddResult = { status: 'added'; source: SourceRow; added: number } | { status: 'exists'; source: SourceRow };

export interface AddOpts {
  groups: SourceGroup[];
  now: number;
  /** Tên và khoá của nguồn gợi ý (nguồn dán tay: tên lấy từ `<title>` của feed). */
  name?: string;
  suggestedKey?: string;
}

/**
 * AC-1: URL → (xin quyền host) → tải → phân tích → LƯU CHỈ KHI PHÂN TÍCH ĐƯỢC. Mọi lỗi ném `AppError` và KHÔNG ghi gì.
 * Không lưu nguồn nào khi chưa tải được bài (nguồn gợi ý cũng vậy — feed gợi ý có thể đã chết).
 */
export async function addSource(sdk: Sdk, raw: string, o: AddOpts): Promise<AddResult> {
  const u = normalizeFeedUrl(raw);
  if (!u.ok) throw new AppError('INVALID_REQUEST', u.message);
  const existing = o.groups.find((g) => g.main.feed_url === u.url);
  if (existing) return { status: 'exists', source: existing.main };
  if (o.groups.length >= MAX_SOURCES) throw new AppError('INVALID_REQUEST', `Tối đa ${MAX_SOURCES} nguồn — bỏ bớt một nguồn rồi thêm lại`);

  let granted = false;
  try {
    granted = (await sdk.net.requestAccess({ host: u.host, reason: `Để tải tin từ ${u.host}` })).granted;
  } catch (e) {
    throw toAppError(e, u.host);
  }
  if (!granted) throw new AppError('NET_BLOCKED', `Chưa cho phép truy cập ${u.host}. Chưa lưu.`);

  const feed = await download(sdk, u.url, u.host, o.now);
  const position = o.groups.reduce((m, g) => Math.max(m, g.main.position), -1) + 1;
  const source: SourceRow = {
    id: newId(),
    name: (o.name?.trim() || feed.title || u.host).slice(0, 100),
    feed_url: u.url,
    host: u.host,
    position,
    suggested_key: o.suggestedKey ?? null,
    last_fetched_at_ms: o.now,
    last_error: null,
  };
  try {
    const r = await insertSourceWithItems(sdk, source, feed.items, o.now);
    return { status: 'added', source, added: r.added };
  } catch (e) {
    throw toAppError(e, u.host);
  }
}

export interface RefreshOutcome {
  id: string;
  ok: boolean;
  error?: AppError;
  added: number;
}

/** Làm mới một nguồn: lỗi mạng (OFFLINE) KHÔNG ghi DB (giữ danh sách + lần cập nhật cuối); lỗi khác ghi `last_error` của nguồn đó. */
export async function refreshSource(sdk: Sdk, group: SourceGroup, now: number, isOffline: () => boolean = () => false): Promise<RefreshOutcome> {
  const src = group.main;
  try {
    const feed = await download(sdk, src.feed_url, src.host, now);
    const r = await upsertItems(sdk, src, feed.items, now);
    return { id: src.id, ok: true, added: r.added };
  } catch (e) {
    let err = toAppError(e, src.host);
    // Mất mạng thật: native fetch có thể treo tới hết giờ (NET_ERROR "Hết thời gian chờ") thay vì OFFLINE — shell đã báo offline thì coi là OFFLINE.
    if (err.code === 'NET_ERROR' && isOffline()) err = new AppError('OFFLINE', 'Không có mạng — kết nối rồi thử lại');
    if (err.code !== 'OFFLINE' && err.code !== 'READ_ONLY') {
      await markSourceError(sdk, src.id, packError(err), src.last_error).catch(() => undefined);
    }
    return { id: src.id, ok: false, error: err, added: 0 };
  }
}

/** Tải mọi nguồn song song (tối đa 4 cùng lúc); nguồn lỗi không chặn nguồn khác. */
export async function refreshAll(sdk: Sdk, groups: SourceGroup[], now: number, onEach?: (o: RefreshOutcome) => void, isOffline?: () => boolean): Promise<RefreshOutcome[]> {
  const out: RefreshOutcome[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= groups.length) return;
      const o = await refreshSource(sdk, groups[i], now, isOffline);
      out.push(o);
      onEach?.(o);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, worker));
  return out;
}
