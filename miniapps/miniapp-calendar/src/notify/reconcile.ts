// Keo SDK ↔ hàm thuần: đọc dữ liệu, tính tập mong muốn, so với `notify.list()`, rồi `schedule` / `cancel`.
import { loadAll } from '../data/repo';
import { defaultEnv, type Env } from '../recur/occurrences';
import { errCode, type Sdk } from '../sdk';
import { desiredNotifications, planNotify, type NotifyItem } from './plan';

export interface ReconcileResult {
  scheduled: number;
  cancelled: number;
  /** Quyền thông báo bị từ chối — mục vẫn lưu, nhưng lời nhắc sẽ không kêu. */
  denied: boolean;
  /** Hệ thống không cho đặt (lỗi khác) — số lần thất bại. */
  failed: number;
}

let running: Promise<ReconcileResult> | null = null;
let again = false;
let pendingForce = new Set<string>();

/** Đối chiếu một lần. Gọi chồng thì gộp: chạy xong lượt đang chạy rồi chạy thêm đúng một lượt (không bao giờ chạy song song). */
export function reconcile(sdk: Sdk, opts: { env?: Env; force?: Iterable<string> } = {}): Promise<ReconcileResult> {
  for (const k of opts.force ?? []) pendingForce.add(k);
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let last: ReconcileResult = { scheduled: 0, cancelled: 0, denied: false, failed: 0 };
    do {
      again = false;
      const force = pendingForce;
      pendingForce = new Set();
      last = await reconcileOnce(sdk, opts.env ?? defaultEnv(), force);
    } while (again);
    return last;
  })().finally(() => {
    running = null;
  });
  return running;
}

export async function reconcileOnce(sdk: Sdk, env: Env, force: Set<string> = new Set()): Promise<ReconcileResult> {
  const res: ReconcileResult = { scheduled: 0, cancelled: 0, denied: false, failed: 0 };
  const { events, overrides } = await loadAll(sdk);
  const desired = desiredNotifications(events, overrides, env, { force });
  const current = (await sdk.notify.list()) as NotifyItem[];
  const plan = planNotify(desired, current, env.now);
  for (const id of plan.cancel) {
    await sdk.notify.cancel(id).then(
      () => void res.cancelled++,
      () => void res.failed++,
    );
  }
  for (const d of plan.schedule) {
    if (res.denied) break;
    try {
      await sdk.notify.schedule({ id: d.id, at: d.at, title: d.title, body: d.body, ref: d.ref });
      res.scheduled++;
    } catch (e) {
      if (errCode(e) === 'PERMISSION_DENIED') res.denied = true;
      else res.failed++;
    }
  }
  return res;
}

/** Xin lại quyền thông báo (nút "Cho phép"): thử đặt đúng một thông báo — shell hỏi quyền. */
export async function retryPermission(sdk: Sdk): Promise<boolean> {
  const r = await reconcile(sdk);
  return !r.denied;
}
