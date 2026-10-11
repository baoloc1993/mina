// C7 thanh tiêu đề: mặc định (tên màn lớn + nút phụ bên phải) · có nút quay lại · mini app (tên app + chip C6 + nút đóng).
import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Txt } from './Txt';
import { color, radius, space, tapMin } from './theme';

interface Props {
  title: string;
  /** Có ⇒ hiện nút ← (dạng "có nút quay lại"). */
  onBack?(): void;
  /** Mini app: nút × ở mép phải, tiêu đề cỡ nhỏ. */
  onClose?(): void;
  /** Chip C6 / nút phụ. */
  right?: ReactNode;
}

export function IconButton({ glyph, label, onPress, testID }: { glyph: string; label: string; onPress(): void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
    >
      <Txt size="lg" weight="title" tone="primary">
        {glyph}
      </Txt>
    </Pressable>
  );
}

export function TitleBar({ title, onBack, onClose, right }: Props) {
  const big = !onBack && !onClose;
  return (
    <View style={styles.bar}>
      {onBack ? <IconButton glyph="←" label="Quay lại" onPress={onBack} testID="titlebar-back" /> : null}
      <Txt
        accessibilityRole="header"
        size={big ? 'xl' : 'lg'}
        weight="title"
        numberOfLines={1}
        style={[styles.title, big && styles.titleBig]}
      >
        {title}
      </Txt>
      {right}
      {onClose ? <IconButton glyph="×" label="Đóng app" onPress={onClose} testID="titlebar-close" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: tapMin + space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: color.bg,
  },
  title: { flex: 1, minWidth: 0 },
  titleBig: { paddingVertical: space.sm },
  icon: { minWidth: tapMin, minHeight: tapMin, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  pressed: { backgroundColor: color.surface },
});
