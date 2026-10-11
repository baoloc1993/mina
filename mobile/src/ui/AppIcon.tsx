// Icon app: `icon.png` của gói nếu có, không thì ô chữ cái đầu của tên trên màu suy từ hash id (trong bảng màu token).
import React, { useState } from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Txt } from './Txt';
import { iconBackground, iconLetter } from './iconColor';
import { fontSize, iconApp, radius } from './theme';

/** Nếu runtime gắn `iconUri` vào AppRow/LauncherApp thì dùng, không thì thôi. */
export function iconUriOf(x: unknown): string | undefined {
  if (x && typeof x === 'object' && 'iconUri' in x) {
    const u = (x as { iconUri?: unknown }).iconUri;
    return typeof u === 'string' && u ? u : undefined;
  }
  return undefined;
}

interface Props {
  appId: string;
  name: string;
  size?: number;
  privateApp?: boolean;
  iconUri?: string;
  style?: StyleProp<ViewStyle>;
}

export function AppIcon({ appId, name, size = iconApp, privateApp, iconUri, style }: Props) {
  const [broken, setBroken] = useState(false);
  const r = size >= iconApp ? radius.lg : radius.md;
  const box = { width: size, height: size, borderRadius: r };
  if (iconUri && !broken) {
    return (
      <View style={[box, styles.clip, style]}>
        <Image source={{ uri: iconUri }} style={box} onError={() => setBroken(true)} accessibilityIgnoresInvertColors />
      </View>
    );
  }
  return (
    <View style={[box, styles.tile, { backgroundColor: iconBackground(appId, privateApp) }, style]}>
      <Txt weight="title" tone="onPrimary" style={{ fontSize: size >= iconApp ? fontSize.xl : fontSize.lg }}>
        {iconLetter(name)}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center' },
  clip: { overflow: 'hidden' },
});
