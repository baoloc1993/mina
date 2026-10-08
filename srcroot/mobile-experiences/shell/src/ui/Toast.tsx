// C10 toast: đáy màn, tự tắt sau 4 s, có thể kèm nút (vd "Mở?"). Loại: thông tin · intent (kèm nút) · lỗi.
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Txt } from './Txt';
import { color, radius, space, tapMin, opacity } from './theme';
import type { ToastItem } from '../runtime/types';

export const TOAST_MS = 4000;

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss(id: number): void }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss]);
  const err = toast.kind === 'error';
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={toast.text}
      style={[styles.toast, { backgroundColor: err ? color.danger : color.text }]}
    >
      <Txt size="sm" tone="onPrimary" style={styles.text}>
        {toast.text}
      </Txt>
      {toast.action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={toast.action.label}
          onPress={() => {
            onDismiss(toast.id);
            toast.action!.run();
          }}
          style={({ pressed }) => [styles.action, pressed && { opacity: opacity.pressed }]}
        >
          <Txt size="sm" weight="label">
            {toast.action.label}
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Đặt ở gốc app; nhận danh sách toast từ Runtime. */
export function ToastHost({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss(id: number): void }) {
  if (toasts.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={styles.host}>
      {toasts.slice(-3).map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: space.md, right: space.md, bottom: space.lg, gap: space.sm },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    minHeight: tapMin,
  },
  text: { flex: 1 },
  action: {
    minHeight: tapMin,
    minWidth: tapMin,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color['on-primary'],
    alignItems: 'center',
    justifyContent: 'center',
  },
});
