// So khớp chữ xác nhận của hộp thoại nguy hiểm (C9 "Xoá hẳn dữ liệu" đòi gõ XOÁ). Thuần TS.

export const PURGE_CONFIRM = 'XOÁ';

/** Đúng chữ (phân biệt hoa/thường và dấu). Chuẩn hoá NFC vì bàn phím Telex/VNI có thể sinh chữ tổ hợp rời. */
export function matchesConfirmText(input: string, expected: string = PURGE_CONFIRM): boolean {
  return input.trim().normalize('NFC') === expected.normalize('NFC');
}
