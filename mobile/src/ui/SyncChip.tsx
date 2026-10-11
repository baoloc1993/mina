// C6 chip trạng thái sync: online đã sync (success) · đang sync (primary, xoay) · offline (warning) · lỗi N bị từ chối (danger, bấm mở S6).
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import type { SyncState } from '../bridge/types';
import { chipInfo } from './chipInfo';
import { Txt, toneColor } from './Txt';

export { chipInfo };
import { chipHeight, color, dotSize, radius, space, stroke, tapMin } from './theme';

interface Props {
  state: SyncState;
  rejected?: number;
  onPress?(): void;
  testID?: string;
}

export function SyncChip({ state, rejected = 0, onPress, testID }: Props) {
  const { tone, text } = chipInfo(state, rejected);
  const inner = (
    <>
      {state === 'syncing' ? (
        <ActivityIndicator size="small" color={toneColor[tone]} />
      ) : (
        <View style={[styles.dot, { backgroundColor: toneColor[tone] }]} />
      )}
      <Txt size="sm" weight="label" tone={tone} numberOfLines={1}>
        {text}
      </Txt>
    </>
  );
  if (!onPress) {
    return (
      <View testID={testID} accessibilityLabel={`Trạng thái đồng bộ: ${text}`} style={styles.chip}>
        {inner}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Trạng thái đồng bộ: ${text}. Mở màn đồng bộ`}
      onPress={onPress}
      hitSlop={{ top: hitV, bottom: hitV, left: space.sm, right: space.sm }}
      style={styles.chip}
    >
      {inner}
    </Pressable>
  );
}

// Hình chip giữ 32dp nhưng vùng chạm phải ≥ tap-min: bù phần thiếu bằng hitSlop dọc.
const hitV = Math.ceil((tapMin - chipHeight) / 2);

const styles = StyleSheet.create({
  chip: {
    minHeight: chipHeight,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: stroke.thin,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  dot: { width: dotSize, height: dotSize, borderRadius: dotSize / 2 },
});
