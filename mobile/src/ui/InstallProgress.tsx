// C12 thanh tiến trình cài gói, 4 bước: tải → xác minh chữ ký → giải nén → migration. Lỗi: chữ danger + nút Thử lại.
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { Button } from './Button';
import { Txt } from './Txt';
import { errorText } from './errorText';
import { stepInfo, STEP_COUNT } from './progress';
import { color, radius, space, stroke } from './theme';
import type { InstallProgress as Progress } from '../runtime/types';

interface Props {
  progress: Progress;
  onRetry?(): void;
}

const TRACK_HEIGHT = space.sm;
const ANIM_MS = 400;

export function InstallProgress({ progress, onRetry }: Props) {
  const info = stepInfo(progress.step);
  const failed = !!progress.error;
  const frac = useRef(new Animated.Value(info.fraction)).current;
  useEffect(() => {
    Animated.timing(frac, { toValue: info.fraction, duration: ANIM_MS, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [frac, info.fraction]);
  const width = frac.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const stepLabel = `Bước ${info.index}/${STEP_COUNT}`;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={failed ? 'Cài không thành công' : `${stepLabel}: ${info.label}`}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(info.fraction * 100) }}
      style={styles.wrap}
    >
      <View style={styles.track}>
        <Animated.View style={[styles.fill, { width, backgroundColor: failed ? color.danger : color.primary }]} />
      </View>
      {failed ? (
        <>
          <Txt size="sm" tone="danger">
            {errorText(progress.error!.code)}
          </Txt>
          {onRetry ? <Button title="Thử lại" variant="secondary" compact onPress={onRetry} /> : null}
        </>
      ) : (
        <Txt size="sm" tone="muted">
          {stepLabel} · {info.label}
        </Txt>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs, alignSelf: 'stretch' },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: radius.md,
    backgroundColor: color.bg,
    borderWidth: stroke.thin,
    borderColor: color.border,
    overflow: 'hidden',
  },
  fill: { height: '100%' },
});
