// Thuần logic của kéo-thả sắp xếp launcher (không import React Native để Jest chạy được).

/** Đưa phần tử từ vị trí `from` sang `to` (các ô giữa dồn lại). Chỉ số ngoài miền được kẹp. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const n = list.length;
  if (n === 0 || from < 0 || from >= n) return list.slice();
  const t = Math.max(0, Math.min(n - 1, to));
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(t, 0, x);
  return out;
}

export interface GridGeometry {
  columns: number;
  cellWidth: number;
  cellHeight: number;
  count: number;
}

/** Góc trên-trái của ô thứ `index`. */
export function slotOrigin(index: number, g: GridGeometry): { x: number; y: number } {
  return { x: (index % g.columns) * g.cellWidth, y: Math.floor(index / g.columns) * g.cellHeight };
}

/** Ô nào chứa điểm (x, y) trong lưới; kẹp vào [0, count-1] để kéo ra ngoài biên vẫn có đích. */
export function slotFromPoint(x: number, y: number, g: GridGeometry): number {
  if (g.count <= 0 || g.cellWidth <= 0 || g.cellHeight <= 0) return 0;
  const col = Math.max(0, Math.min(g.columns - 1, Math.floor(x / g.cellWidth)));
  const row = Math.max(0, Math.floor(y / g.cellHeight));
  return Math.max(0, Math.min(g.count - 1, row * g.columns + col));
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
