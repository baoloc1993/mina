// Chữ theo token: cỡ (sm/base/lg/xl), trọng lượng (title 700 / label 600 / regular 400), màu ngữ nghĩa.
import React from 'react';
import { Text, type TextProps } from 'react-native';
import { color, type, weight as W, type FontSizeToken } from './theme';

export type Tone = 'text' | 'muted' | 'primary' | 'danger' | 'success' | 'warning' | 'onPrimary';

export const toneColor: Record<Tone, string> = {
  text: color.text,
  muted: color['text-muted'],
  primary: color.primary,
  danger: color.danger,
  success: color.success,
  warning: color.warning,
  onPrimary: color['on-primary'],
};

interface Props extends TextProps {
  size?: FontSizeToken;
  weight?: keyof typeof W;
  tone?: Tone;
  center?: boolean;
}

export function Txt({ size = 'base', weight = 'regular', tone = 'text', center, style, ...rest }: Props) {
  return (
    <Text
      {...rest}
      style={[type[size], { color: toneColor[tone], fontWeight: W[weight] }, center && { textAlign: 'center' }, style]}
    />
  );
}
