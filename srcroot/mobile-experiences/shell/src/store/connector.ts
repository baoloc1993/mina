// Sync connector (CAP-SYNC-04, AC-10, AC-13): JWT cho PowerSync + đẩy thay đổi local lên `upload` v1.
// Lô chia ≤ 100 thay đổi. `REJECTED` ghi sẵn ở server (sync_rejections) nên tách khỏi hàng đợi, không chặn lô.
// 401 → báo UI về S1 (hàng đợi giữ); 403 READ_ONLY → giữ nguyên hàng đợi, báo entitlement; lỗi khác → ném để engine thử lại.
import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector } from '@powersync/common';
import { rateLimitDelayMs } from './retryAfter';
import { config } from '../config';
import { supabase } from '../auth/supabase';
import { chunk, UPLOAD_BATCH } from './chunk';


export interface UploadResult {
  id: string;
  ok: boolean;
  status?: 'ACCEPTED' | 'IGNORED' | 'REJECTED';
  code?: string;
}

export interface ConnectorHooks {
  onUnauthorized(): void;
  onReadOnly(): void;
  /** Số thay đổi bị từ chối trong lô vừa gửi (đã có dòng ở sync_rejections phía server). */
  onRejected(count: number): void;
  onUploaded(): void;
}

export class Connector implements PowerSyncBackendConnector {
  constructor(private hooks: ConnectorHooks) {}

  async fetchCredentials() {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) {
      this.hooks.onUnauthorized();
      throw new Error('Chưa đăng nhập');
    }
    return { endpoint: config.powersyncUrl, token: data.session.access_token };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const tx = await database.getNextCrudTransaction();
    if (!tx) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      this.hooks.onUnauthorized();
      throw new Error('Chưa đăng nhập');
    }
    const ops = tx.crud.map((c) => ({ op: c.op, table: c.table, id: c.id, data: c.opData }));
    for (const part of chunk(ops, UPLOAD_BATCH)) {
      // Timeout + không tái dùng kết nối: kết nối keep-alive chết sau khi mất mạng làm upload treo ~40 s (đo ở vòng 1).
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      let res: Response;
      try {
        res = await fetch(`${config.supabaseUrl}/functions/v1/upload`, {
          method: 'POST',
          signal: ctl.signal,
          headers: {
            connection: 'close',
            'content-type': 'application/json',
            authorization: `Bearer ${data.session.access_token}`,
            apikey: config.supabaseAnonKey,
          },
          body: JSON.stringify({ ops: part }),
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401) {
        this.hooks.onUnauthorized();
        throw new Error('upload HTTP 401');
      }
      if (res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'READ_ONLY') this.hooks.onReadOnly();
        throw new Error(`upload HTTP 403 ${body.error ?? ''}`.trim());
      }
      if (res.status === 429) {
        // RATE_LIMITED: lô CHƯA áp gì (server đếm trước khi xử lý) — đợi theo Retry-After rồi để engine gửi lại cả giao dịch.
        const b = (await res.json().catch(() => ({}))) as { retry_after_s?: unknown };
        await new Promise((r) => setTimeout(r, rateLimitDelayMs(res.headers.get('retry-after'), b.retry_after_s)));
        throw new Error('upload HTTP 429');
      }
      if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
      const body = (await res.json()) as { results: UploadResult[] };
      const rejected = body.results.filter((r) => (r.status ?? (r.ok ? 'ACCEPTED' : 'REJECTED')) === 'REJECTED').length;
      if (rejected) this.hooks.onRejected(rejected);
    }
    await tx.complete();
    this.hooks.onUploaded();
  }
}
