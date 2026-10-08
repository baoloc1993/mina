// C8 banner ngang: cảnh báo (warning: offline, chỉ đọc, cần mạng để cài) · lỗi (danger: bản bị thu hồi) · thông tin (primary).
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button } from './Button';
import { Glyph } from './Glyph';
import { Txt, toneColor, type Tone } from './Txt';
import { color, radius, space, stroke } from './theme';

export type BannerTone = 'warning' | 'error' | 'info';

const MAP: Record<BannerTone, { tone: Tone; char: string; label: string }> = {
  warning: { tone: 'warning', char: '!', label: 'Cảnh báo' },
  error: { tone: 'danger', char: '!', label: 'Lỗi' },
  info: { tone: 'primary', char: 'i', label: 'Thông tin' },
};

interface Props {
  tone: BannerTone;
  text: string;
  actionLabel?: string;
  onAction?(): void;
  /** Cả banner bấm được (thay cho nút) — gọn hơn ở màn thấp. */
  onPress?(): void;
  testID?: string;
}

export function Banner({ tone, text, actionLabel, onAction, onPress, testID }: Props) {
  const m = MAP[tone];
  const Wrap = onPress ? Pressable : View;
  return (
    <Wrap
      {...(onPress ? { onPress } : {})}
      testID={testID}
      accessibilityRole={onPress ? 'button' : 'alert'}
      accessibilityLabel={`${m.label}: ${text}`}
      style={[styles.banner, { borderLeftColor: toneColor[m.tone] }]}
    >
      <Glyph char={m.char} tone={m.tone} />
      <Txt size="sm" tone={m.tone} style={styles.text}>
        {text}
      </Txt>
      {actionLabel && onAction ? <Button title={actionLabel} onPress={onAction} variant="secondary" compact /> : null}
      {onPress ? (
        <Txt size="lg" tone={m.tone} accessibilityElementsHidden importantForAccessibility="no">
          ›
        </Txt>
      ) : null}
    </Wrap>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderLeftWidth: stroke.accent,
  },
  text: { flex: 1 },
});
