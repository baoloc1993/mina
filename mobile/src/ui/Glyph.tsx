// Vòng tròn có một ký tự ("!", "i", "×"…): icon trạng thái tự vẽ, không phụ thuộc font emoji của máy.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Txt, toneColor, type Tone } from './Txt';
import { badgeSize, stroke } from './theme';

export function Glyph({ char, tone = 'muted', size = badgeSize }: { char: string; tone?: Tone; size?: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2, borderColor: toneColor[tone] }]}
    >
      <Txt tone={tone} weight="title" style={{ fontSize: Math.round(size / 2), lineHeight: size - stroke.focus * 2 }}>
        {char}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { borderWidth: stroke.focus, alignItems: 'center', justifyContent: 'center' },
});
