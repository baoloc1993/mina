// Đổi mã HTTP của `catalog` thành lỗi shell hiểu (vòng 7). Tách khỏi api.ts để test Jest không phải nạp module native.
// 429 `RATE_LIMITED` (trần theo user ở server) là lỗi TẠM: coi như OFFLINE — giữ bản catalog đã cache, không hiện lỗi.
import { PackageError } from '../packages/types';

export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED';
}

/** `null` khi `status` OK; còn lại trả lỗi để ném. */
export function catalogStatusError(status: number): UnauthorizedError | PackageError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return new UnauthorizedError('Phiên đăng nhập hết hiệu lực');
  if (status === 429) return new PackageError('OFFLINE', 'Máy chủ đang giới hạn tần suất — thử lại sau');
  return new PackageError('INTERNAL', `catalog HTTP ${status}`);
}
