// C9 hộp thoại xác nhận: mở · đang xử lý · biến thể nguy hiểm đòi gõ đúng chữ (vd "XOÁ" khi xoá hẳn dữ liệu).
import React, { useEffect, useState, type ReactNode } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { Button } from './Button';
import { TextField } from './TextField';
import { Txt } from './Txt';
import { matchesConfirmText } from './confirmText';
import { color, opacity, radius, shadow, space } from './theme';
import { useKeyboardHeight } from './useKeyboardHeight';

interface Props {
  visible: boolean;
  title: string;
  message?: string;
  /** Dòng phụ màu warning (vd "Đang offline — cần mạng"). */
  notice?: string;
  /** Lỗi của lần xác nhận trước (ở lại trong hộp thoại để người dùng đọc). */
  error?: string | null;
  confirmLabel: string;
  cancelLabel?: string;
  busyLabel?: string;
  /** Nút xác nhận màu nguy hiểm. */
  danger?: boolean;
  /** Đòi gõ đúng chữ này mới bật nút xác nhận. */
  requireText?: string;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
  children?: ReactNode;
}

export function ConfirmDialog({
  visible,
  title,
  message,
  notice,
  error,
  confirmLabel,
  cancelLabel = 'Huỷ',
  busyLabel = 'Đang xử lý…',
  danger,
  requireText,
  busy,
  onConfirm,
  onCancel,
  children,
}: Props) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (!visible) setTyped('');
  }, [visible]);
  const kb = useKeyboardHeight();
  const ok = !requireText || matchesConfirmText(typed, requireText);
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={() => !busy && onCancel()}>
      <View style={styles.root}>
        <View style={styles.scrim} />
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.center, { paddingBottom: kb }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View accessibilityViewIsModal style={styles.dialog}>
            <Txt size="lg" weight="title" accessibilityRole="header">
              {title}
            </Txt>
            {message ? <Txt>{message}</Txt> : null}
            {children}
            {requireText ? (
              <TextField
                label={`Gõ ${requireText} để xác nhận`}
                value={typed}
                onChangeText={setTyped}
                placeholder={requireText}
                autoCapitalize="characters"
                autoCorrect={false}
                disabled={busy}
                testID="confirm-text"
              />
            ) : null}
            {notice ? (
              <Txt size="sm" tone="warning">
                {notice}
              </Txt>
            ) : null}
            {error ? (
              <Txt size="sm" tone="danger" accessibilityLiveRegion="polite">
                {error}
              </Txt>
            ) : null}
            <View style={styles.row}>
              <Button title={cancelLabel} variant="secondary" onPress={onCancel} disabled={busy} style={styles.flex} />
              <Button
                title={confirmLabel}
                variant={danger ? 'danger' : 'primary'}
                busy={busy}
                busyTitle={busyLabel}
                disabled={!ok}
                onPress={onConfirm}
                style={styles.flex}
                testID="confirm-ok"
              />
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: color.overlay, opacity: opacity.overlay },
  center: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: space.md, paddingVertical: space.md },
  dialog: { backgroundColor: color.bg, borderRadius: radius.lg, padding: space.md, gap: space.md, ...shadow },
  row: { flexDirection: 'row', gap: space.sm },
  flex: { flex: 1 },
});
