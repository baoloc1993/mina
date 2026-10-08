// C1 nút chính · C2 nút phụ / nguy hiểm. Cao ≥ tap-min, bo radius-md.
// Trạng thái: mặc định · đang xử lý (spinner + chữ "Đang…", khoá bấm lại) · tắt (mờ 40%, không bấm).
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Txt, toneColor, type Tone } from './Txt';
import { color, opacity, radius, space, stroke, tapMin } from './theme';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerOutline' | 'ghost';

interface Props {
  title: string;
  onPress(): void;
  variant?: ButtonVariant;
  /** Đang xử lý: hiện spinner + `busyTitle`, bấm không có tác dụng. */
  busy?: boolean;
  busyTitle?: string;
  disabled?: boolean;
  /** Vừa nội dung thay vì kín chiều ngang (vẫn cao ≥ tap-min). */
  compact?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const VARIANT: Record<ButtonVariant, { bg: string; fg: Tone; border: string }> = {
  primary: { bg: color.primary, fg: 'onPrimary', border: color.primary },
  secondary: { bg: color.bg, fg: 'primary', border: color.border },
  danger: { bg: color.danger, fg: 'onPrimary', border: color.danger },
  dangerOutline: { bg: color.bg, fg: 'danger', border: color.danger },
  ghost: { bg: 'transparent', fg: 'primary', border: 'transparent' },
};

export function Button({ title, onPress, variant = 'primary', busy, busyTitle = 'Đang xử lý…', disabled, compact, accessibilityLabel, testID, style }: Props) {
  const v = VARIANT[variant];
  const inactive = !!disabled || !!busy;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (busy ? busyTitle : title)}
      accessibilityState={{ disabled: inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: v.bg, borderColor: v.border },
        compact ? styles.compact : styles.block,
        disabled && !busy && { opacity: opacity.disabled },
        pressed && { opacity: opacity.pressed },
        style,
      ]}
    >
      <View style={styles.row}>
        {busy ? <ActivityIndicator size="small" color={toneColor[v.fg]} /> : null}
        <Txt weight="label" tone={v.fg} numberOfLines={2} style={styles.label}>
          {busy ? busyTitle : title}
        </Txt>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: tapMin,
    borderRadius: radius.md,
    borderWidth: stroke.thin,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    justifyContent: 'center',
    alignItems: 'center',
  },
  block: { alignSelf: 'stretch' },
  compact: { alignSelf: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  label: { textAlign: 'center', flexShrink: 1 },
});
