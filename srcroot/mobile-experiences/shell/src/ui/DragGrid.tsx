// Lưới sắp xếp bằng giữ-kéo (AC-5), chỉ dùng PanResponder + Animated (KHÔNG reanimated / gesture-handler: cần build native lại).
// Giữ ~400 ms ⇒ vào chế độ kéo; kéo tới ô khác ⇒ các ô dồn chỗ; thả ⇒ onReorder(ids).
// Mọi ô render theo thứ tự `items` gốc và chỉ đổi toạ độ — không đổi thứ tự con để không huỷ cử chỉ đang chạy.
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import type { IconHandlers } from './LauncherIcon';
import { moveItem, sameOrder, slotFromPoint, slotOrigin, type GridGeometry } from './reorder';
import { launcherColumns, launcherRowHeight } from './theme';

export const LONG_PRESS_MS = 400;
const SNAP_MS = 120;
const SETTLE_FALLBACK_MS = 2000;

interface Props<T extends { app_id: string }> {
  items: T[];
  renderItem(item: T, dragging: boolean, handlers: IconHandlers): ReactNode;
  onPressItem(item: T): void;
  onReorder(ids: string[]): Promise<void> | void;
  /** Cha tắt cuộn khi đang kéo. */
  onDragChange?(dragging: boolean): void;
}

interface Drag {
  id: string;
  order: string[];
  start: { x: number; y: number };
  startPage: { x: number; y: number };
  captured: boolean;
}

export function DragGrid<T extends { app_id: string }>({ items, renderItem, onPressItem, onReorder, onDragChange }: Props<T>) {
  const [width, setWidth] = useState(0);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const pos = useRef(new Animated.ValueXY()).current;
  const drag = useRef<Drag | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const baseIds = useMemo(() => items.map((i) => i.app_id), [items]);
  const baseSig = baseIds.join('|');
  const order = preview ?? baseIds;

  const geo: GridGeometry = useMemo(
    () => ({ columns: launcherColumns, cellWidth: width / launcherColumns, cellHeight: launcherRowHeight, count: order.length }),
    [width, order.length],
  );
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const propsRef = useRef({ baseIds, onReorder, onDragChange });
  propsRef.current = { baseIds, onReorder, onDragChange };

  // Runtime đã trả thứ tự mới ⇒ bỏ bản xem trước.
  useEffect(() => {
    setPreview(null);
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, [baseSig]);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const finish = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const finalIndex = d.order.indexOf(d.id);
    const target = slotOrigin(finalIndex, geoRef.current);
    Animated.timing(pos, { toValue: target, duration: SNAP_MS, useNativeDriver: false }).start(() => {
      setDragId(null);
      propsRef.current.onDragChange?.(false);
    });
    const { baseIds: base, onReorder: fire } = propsRef.current;
    if (sameOrder(d.order, base)) {
      setPreview(null);
      return;
    }
    setPreview(d.order);
    settleTimer.current = setTimeout(() => setPreview(null), SETTLE_FALLBACK_MS);
    Promise.resolve(fire(d.order)).catch(() => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      setPreview(null);
    });
  }, [pos]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponderCapture: () => {
          if (!drag.current) return false;
          drag.current.captured = true;
          return true;
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.nativeEvent.pageX - d.startPage.x;
          const dy = e.nativeEvent.pageY - d.startPage.y;
          const g = geoRef.current;
          const x = d.start.x + dx;
          const y = d.start.y + dy;
          pos.setValue({ x, y });
          const target = slotFromPoint(x + g.cellWidth / 2, y + g.cellHeight / 2, g);
          const cur = d.order.indexOf(d.id);
          if (target !== cur) {
            d.order = moveItem(d.order, cur, target);
            setPreview(d.order);
          }
        },
        onPanResponderRelease: () => finish(),
        onPanResponderTerminate: () => finish(),
      }),
    [finish, pos],
  );

  const startDrag = useCallback(
    (id: string, e: GestureResponderEvent) => {
      if (drag.current) return;
      const cur = order.indexOf(id);
      if (cur < 0) return;
      const start = slotOrigin(cur, geoRef.current);
      drag.current = { id, order: order.slice(), start, startPage: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }, captured: false };
      pos.setValue(start);
      setDragId(id);
      propsRef.current.onDragChange?.(true);
    },
    [order, pos],
  );

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const rows = Math.ceil(order.length / launcherColumns);

  return (
    <View onLayout={onLayout} style={{ height: rows * launcherRowHeight }} {...responder.panHandlers}>
      {width > 0
        ? items.map((item) => {
            const id = item.app_id;
            const dragging = dragId === id;
            const idx = order.indexOf(id);
            const o = slotOrigin(idx < 0 ? 0 : idx, geo);
            const handlers: IconHandlers = {
              onPress: () => onPressItem(item),
              onLongPress: (e) => startDrag(id, e),
              // Giữ rồi nhả mà không kéo: Pressable vẫn là responder ⇒ tự kết thúc chế độ kéo.
              onPressOut: () => {
                if (drag.current && drag.current.id === id && !drag.current.captured) finish();
              },
              delayLongPress: LONG_PRESS_MS,
            };
            return (
              <Animated.View
                key={id}
                style={[
                  styles.cell,
                  { width: geo.cellWidth, height: geo.cellHeight },
                  dragging
                    ? { transform: [{ translateX: pos.x }, { translateY: pos.y }], zIndex: 2 }
                    : { transform: [{ translateX: o.x }, { translateY: o.y }] },
                ]}
              >
                {renderItem(item, dragging, handlers)}
              </Animated.View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cell: { position: 'absolute', left: 0, top: 0 },
});
