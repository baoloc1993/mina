// Màu icon app: ô chữ cái đầu của tên app trên màu suy từ hash id — luôn nằm TRONG bảng màu token (chữ on-primary đạt AA trên cả 4).
import { color } from './theme';

export type IconTone = 'primary' | 'success' | 'warning' | 'text-muted';
export const ICON_TONES: IconTone[] = ['primary', 'success', 'warning', 'text-muted'];

export function hashId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  return h;
}

/** App riêng của tenant luôn `warning` (prototype); còn lại theo hash. */
export function iconTone(appId: string, privateToTenant = false): IconTone {
  if (privateToTenant) return 'warning';
  return ICON_TONES[hashId(appId) % ICON_TONES.length];
}

export function iconBackground(appId: string, privateToTenant = false): string {
  return color[iconTone(appId, privateToTenant)];
}

export function iconLetter(name: string): string {
  const t = name.trim();
  if (!t) return '?';
  return Array.from(t)[0].toLocaleUpperCase('vi');
}
