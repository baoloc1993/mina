// Điều hướng bằng state (stack) — sơ đồ PROTOTYPE.md §2. S1 (chưa đăng nhập) và S5 (mini app) do Router quyết theo RuntimeState.
export type Route =
  | { name: 'launcher' }
  | { name: 'catalog' }
  | { name: 'detail'; appId: string }
  | { name: 'sync' }
  | { name: 'devices' }
  | { name: 'account' };

export interface Nav {
  push(r: Route): void;
  back(): void;
}

/** Chuyển stack theo BACK: trả stack mới, hoặc null nếu đang ở gốc (để hệ thống xử lý). */
export function popRoute(stack: readonly Route[]): Route[] | null {
  return stack.length > 1 ? stack.slice(0, -1) : null;
}

/** Đẩy route; nếu route cùng loại đã ở đỉnh thì thay (tránh chồng S6 → S6). */
export function pushRoute(stack: readonly Route[], r: Route): Route[] {
  const top = stack[stack.length - 1];
  if (top && top.name === r.name && (r.name !== 'detail' || (top as { appId?: string }).appId === r.appId)) return stack.slice();
  return [...stack, r];
}
