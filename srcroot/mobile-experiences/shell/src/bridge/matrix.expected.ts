// Bảng kỳ vọng ĐÓNG BĂNG của ma trận scope (AC-9, AC-15): mỗi dòng "<method>|<không scope>|<có scope>|<chỉ đọc>".
// Quy tắc đọc: thiếu scope → SCOPE_DENIED; method ghi + chỉ đọc → READ_ONLY; `sdk.*` và `sync.status` luôn OK.
// Mock SDK (Vitest + màn S10) và Jest của shell đều so `summarizeMatrix()` (matrix.ts) với bảng này — đổi hành vi
// bridge mà quên sửa bảng thì test đỏ. Sửa bảng này là sửa hợp đồng SDK: cần dòng DECISIONS.
export const EXPECTED_SUMMARY: string[] = [
  'sdk.ready|OK|OK|OK',
  'sdk.info|OK|OK|OK',
  'db.query|SCOPE_DENIED|OK|OK',
  'db.execute|SCOPE_DENIED|OK|READ_ONLY',
  'db.transaction|SCOPE_DENIED|OK|READ_ONLY',
  'core.tags.list|SCOPE_DENIED|OK|OK',
  'core.tags.create|SCOPE_DENIED|OK|READ_ONLY',
  'core.contacts.search|SCOPE_DENIED|OK|OK',
  'core.contacts.create|SCOPE_DENIED|OK|READ_ONLY',
  'core.files.list|SCOPE_DENIED|OK|OK',
  'intent.send|SCOPE_DENIED|OK|READ_ONLY',
  'notify.schedule|SCOPE_DENIED|OK|OK',
  'notify.cancel|SCOPE_DENIED|OK|OK',
  'notify.list|SCOPE_DENIED|OK|OK',
  'storage.put|SCOPE_DENIED|OK|READ_ONLY',
  'storage.get|SCOPE_DENIED|OK|OK',
  'storage.remove|SCOPE_DENIED|OK|READ_ONLY',
  'net.fetch|SCOPE_DENIED|OK|OK',
  'ui.toast|SCOPE_DENIED|OK|OK',
  'ui.pickImage|SCOPE_DENIED|OK|READ_ONLY',
  'ui.pickFile|SCOPE_DENIED|OK|READ_ONLY',
  'ui.share|SCOPE_DENIED|OK|OK',
  'sync.status|OK|OK|OK',
  'auth.getAppToken|SCOPE_DENIED|OK|OK',
];
