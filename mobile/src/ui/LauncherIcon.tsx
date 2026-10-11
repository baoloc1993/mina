// C5 icon launcher (64dp, nhãn dưới, bo radius-lg). Bình thường · đang kéo (nổi shadow, phóng 1.05) ·
// có cập nhật chờ (chấm primary) · bị thu hồi / không mở được (mờ + gạch).
import React from 'react';
import { Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import { AppIcon, iconUriOf } from './AppIcon';
import { Txt } from './Txt';
import { color, dotSize, dragScale, iconApp, opacity, shadow, space, stroke, radius } from './theme';
import type { LauncherApp } from '../runtime/types';

export interface IconHandlers {
  onPress(): void;
  onLongPress(e: GestureResponderEvent): void;
  onPressOut(): void;
  delayLongPress: number;
}

export function LauncherIcon({ app, dragging, handlers }: { app: LauncherApp; dragging: boolean; handlers: IconHandlers }) {
  const label = app.name + (app.updatePending ? ' — có bản mới chờ' : '') + (app.blocked ? ' — không mở được' : '');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Chạm để mở. Giữ rồi kéo để sắp xếp lại"
      onPress={handlers.onPress}
      onLongPress={handlers.onLongPress}
      onPressOut={handlers.onPressOut}
      delayLongPress={handlers.delayLongPress}
      style={({ pressed }) => [styles.cell, pressed && !dragging && { opacity: opacity.pressed }]}
    >
      <View style={[styles.iconWrap, dragging && styles.dragging]}>
        <AppIcon
          appId={app.app_id}
          name={app.name}
          size={iconApp}
          privateApp={app.private_to_tenant}
          iconUri={iconUriOf(app)}
          style={app.blocked ? styles.dim : undefined}
        />
        {app.updatePending ? <View style={styles.dot} /> : null}
      </View>
      <Txt size="sm" tone={app.blocked ? 'muted' : 'text'} center numberOfLines={2} style={app.blocked ? styles.struck : undefined}>
        {app.name}
      </Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: { flex: 1, alignItems: 'center', gap: space.xs, paddingHorizontal: space.xs },
  iconWrap: { width: iconApp, height: iconApp, borderRadius: radius.lg },
  dragging: { ...shadow, transform: [{ scale: dragScale }], borderWidth: stroke.focus, borderColor: color.primary },
  dim: { opacity: opacity.dim },
  struck: { textDecorationLine: 'line-through' },
  dot: {
    position: 'absolute',
    top: -space.xs,
    right: -space.xs,
    width: dotSize + space.xs,
    height: dotSize + space.xs,
    borderRadius: (dotSize + space.xs) / 2,
    backgroundColor: color.primary,
    borderWidth: stroke.focus,
    borderColor: color.bg,
  },
});
