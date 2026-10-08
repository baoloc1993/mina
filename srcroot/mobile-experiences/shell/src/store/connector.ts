// Sync connector: lấy JWT phiên cho PowerSync, đẩy thay đổi local lên Edge Function `upload`.
// REJECTED không tự xoá: ném lỗi để engine giữ lô lại và báo lỗi qua trạng thái sync.
import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector } from '@powersync/react-native';
import { config } from '../config';
import { supabase } from '../auth/supabase';

export class Connector implements PowerSyncBackendConnector {
  async fetchCredentials() {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new Error('Chưa đăng nhập');
    return { endpoint: config.powersyncUrl, token: data.session.access_token };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const tx = await database.getNextCrudTransaction();
    if (!tx) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error('Chưa đăng nhập');
    const ops = tx.crud.map((c) => ({ op: c.op, table: c.table, id: c.id, data: c.opData }));
    const res = await fetch(`${config.supabaseUrl}/functions/v1/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${data.session.access_token}`,
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify({ ops }),
    });
    if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
    const body = (await res.json()) as { results: { id: string; ok: boolean; error?: string }[] };
    const failed = body.results.filter((r) => !r.ok);
    if (failed.length) throw new Error(`upload bị từ chối ${failed.length}/${ops.length}: ${failed[0].error}`);
    await tx.complete();
  }
}
