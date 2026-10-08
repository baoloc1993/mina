// Scope manifest → câu cho màn S4 "App này dùng" (PROTOTYPE S4). Thuần TS.

const FIXED: Record<string, string> = {
  db: 'Lưu dữ liệu riêng của app',
  'db.own': 'Lưu dữ liệu riêng của app',
  'intent.send': 'Gửi yêu cầu tới app khác',
  'notify.local': 'Thông báo',
  'storage.files': 'Lưu ảnh và tệp của app',
  'ui.native': 'Chọn ảnh và chia sẻ',
  'auth.token': 'Xác thực với máy chủ riêng của app',
};

const CORE: Record<string, string> = { tags: 'Thẻ dùng chung', contacts: 'Danh bạ dùng chung', files: 'Tệp dùng chung' };

export function scopeLines(scopes: readonly string[] | undefined | null, network: readonly string[] | undefined | null): string[] {
  const set = new Set(scopes ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const sc of set) {
    const core = /^core\.([a-z]+):(read|write)$/.exec(sc);
    if (core) {
      const [, ent, mode] = core;
      const label = CORE[ent] ?? `Dữ liệu dùng chung (${ent})`;
      if (mode === 'write') push(`${label} (đọc và ghi)`);
      else if (!set.has(`core.${ent}:write`)) push(`${label} (chỉ đọc)`);
      continue;
    }
    if (sc === 'net') {
      const hosts = (network ?? []).filter(Boolean);
      push(hosts.length ? `Mạng tới ${hosts.join(', ')}` : 'Truy cập mạng');
      continue;
    }
    push(FIXED[sc] ?? sc);
  }
  return out;
}
