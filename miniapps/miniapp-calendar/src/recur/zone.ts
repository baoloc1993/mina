// Múi giờ: "giờ treo" dùng múi giờ máy (Date), "giờ cố định" dùng múi giờ gốc của sự kiện (Intl). Tách thành đối tượng `Zone` để test được
// ở nhiều múi giờ mà không đụng tới biến môi trường TZ. Mini app chỉ dùng Intl/Date của WebView (ARCHITECTURE §8: không thư viện múi giờ).
import { fmtYmd, isLocal, pad2 } from './dates';

export interface Zone {
  id: string;
  /** `YYYY-MM-DDTHH:mm` (giờ đồng hồ trong múi giờ này) → epoch ms. */
  localToMs(local: string): number;
  /** epoch ms → `YYYY-MM-DDTHH:mm` trong múi giờ này. */
  msToLocal(ms: number): string;
}

const parts = (local: string) => {
  const y = Number(local.slice(0, 4));
  const mo = Number(local.slice(5, 7));
  const d = Number(local.slice(8, 10));
  const h = local.length >= 16 ? Number(local.slice(11, 13)) : 0;
  const mi = local.length >= 16 ? Number(local.slice(14, 16)) : 0;
  return { y, mo, d, h, mi };
};

/** Múi giờ của máy (Date địa phương). */
export const deviceZone: Zone = {
  id: 'device',
  localToMs(local) {
    const p = parts(local);
    return new Date(p.y, p.mo - 1, p.d, p.h, p.mi).getTime();
  },
  msToLocal(ms) {
    const t = new Date(ms);
    return `${fmtYmd(t.getFullYear(), t.getMonth() + 1, t.getDate())}T${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  },
};

/** Múi giờ lệch cố định (phút so với UTC) — dùng trong test và khi không có Intl. */
export function fixedOffsetZone(minutes: number, id = `UTC${minutes >= 0 ? '+' : '-'}${Math.abs(minutes) / 60}`): Zone {
  return {
    id,
    localToMs(local) {
      const p = parts(local);
      return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - minutes * 60_000;
    },
    msToLocal(ms) {
      const t = new Date(ms + minutes * 60_000);
      return `${fmtYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())}T${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
    },
  };
}

/** Múi giờ IANA (vd "Asia/Ho_Chi_Minh") qua Intl. Tên lạ → null. */
export function intlZone(tz: string): Zone | null {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
  const wall = (ms: number): string => {
    const o: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
    return `${o.year}-${o.month}-${o.day}T${o.hour === '24' ? '00' : o.hour}:${o.minute}`;
  };
  return {
    id: tz,
    msToLocal: wall,
    localToMs(local) {
      const p = parts(local);
      const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
      // lặp 2 lần: ước lượng độ lệch tại thời điểm đoán rồi sửa (đủ cho mọi múi giờ, kể cả qua mốc đổi giờ)
      let guess = asUtc;
      for (let i = 0; i < 2; i++) {
        const w = parts(wall(guess));
        const off = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - guess;
        guess = asUtc - off;
      }
      return guess;
    },
  };
}

export function zoneOf(tz: string | null | undefined, fallback: Zone): Zone {
  if (!tz) return fallback;
  return intlZone(tz) ?? fallback;
}

export function deviceTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export { isLocal };
