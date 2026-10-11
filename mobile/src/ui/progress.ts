// Bốn bước cài gói của C12: tải → xác minh chữ ký → giải nén → migration. Thuần TS.
import type { InstallStep } from '../packages/types';

export interface StepInfo {
  /** 1..4 (4 bước hiển thị); `register`/`done` coi là bước 4 / xong. */
  index: number;
  fraction: number;
  label: string;
}

export const STEP_COUNT = 4;

export function stepInfo(step: InstallStep): StepInfo {
  switch (step) {
    case 'download':
      return { index: 1, fraction: 0.2, label: 'Đang tải gói…' };
    case 'verify':
      return { index: 2, fraction: 0.45, label: 'Đang xác minh chữ ký…' };
    case 'extract':
      return { index: 3, fraction: 0.65, label: 'Đang giải nén…' };
    case 'migrate':
      return { index: 4, fraction: 0.85, label: 'Đang chuẩn bị dữ liệu cho app…' };
    case 'register':
      return { index: 4, fraction: 0.95, label: 'Đang hoàn tất…' };
    case 'done':
      return { index: 4, fraction: 1, label: 'Xong' };
  }
}
