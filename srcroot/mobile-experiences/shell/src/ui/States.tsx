// C13 ba khuôn dùng chung (DESIGN-SYSTEM §5): rỗng · lỗi (có Thử lại) · đang tải (khối xám nhấp nháy, không spinner toàn màn).
import React, { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { Button } from './Button';
import { Txt } from './Txt';
import { errorSentence } from './errorText';
import { color, glyphBig, iconApp, iconCard, launcherColumns, opacity, radius, space, tapMin } from './theme';

export function EmptyState({ glyph = '▦', text, actionLabel, onAction }: { glyph?: string; text: string; actionLabel?: string; onAction?(): void }) {
  return (
    <View style={styles.center} accessibilityRole="text" accessibilityLabel={text}>
      <Txt tone="muted" style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no">
        {glyph}
      </Txt>
      <Txt tone="muted" center>
        {text}
      </Txt>
      {actionLabel && onAction ? <Button title={actionLabel} onPress={onAction} compact style={styles.self} /> : null}
    </View>
  );
}

/** `code` là mã lỗi (hiện trong ngoặc nhỏ cho P4). `retryable` false ⇒ chỉ chữ + gợi ý (vd bản bị thu hồi). */
export function ErrorState({
  code,
  text,
  hint,
  onRetry,
  glyph = '!',
}: {
  code: string;
  text?: string;
  hint?: string;
  onRetry?(): void;
  glyph?: string;
}) {
  return (
    <View style={styles.center} accessibilityRole="alert">
      <Txt tone="danger" style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no">
        {glyph}
      </Txt>
      <Txt tone="danger" center>
        {text ?? errorSentence(code)}
      </Txt>
      <Txt size="sm" tone="muted" center>
        ({code})
      </Txt>
      {hint ? (
        <Txt size="sm" tone="muted" center>
          {hint}
        </Txt>
      ) : null}
      {onRetry ? <Button title="Thử lại" variant="secondary" compact onPress={onRetry} style={styles.self} /> : null}
    </View>
  );
}

/** Khối nhấp nháy (opacity 1 ↔ faint). */
export function Pulse({ children }: { children: ReactNode }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: opacity.dim, duration: 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={{ opacity: v }}>{children}</Animated.View>;
}

/** 3 khối đúng hình dạng nội dung sắp hiện. `onTimeout` gọi sau 8 s (chuyển sang khuôn lỗi OFFLINE nếu không có mạng). */
export function LoadingState({
  kind = 'cards',
  count = 3,
  onTimeout,
}: {
  kind?: 'cards' | 'rows' | 'icons';
  count?: number;
  onTimeout?(): void;
}) {
  useEffect(() => {
    if (!onTimeout) return;
    const t = setTimeout(onTimeout, 8000);
    return () => clearTimeout(t);
  }, [onTimeout]);
  const items = Array.from({ length: kind === 'icons' ? launcherColumns : count }, (_, i) => i);
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Đang tải" style={kind === 'icons' ? styles.iconRow : styles.stack}>
      {items.map((i) => (
        <Pulse key={i}>
          <View style={kind === 'cards' ? styles.card : kind === 'rows' ? styles.row : styles.icon} />
        </Pulse>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: space.md, paddingVertical: space.xl, paddingHorizontal: space.md },
  glyph: { fontSize: glyphBig, lineHeight: glyphBig + space.sm, opacity: opacity.faint },
  self: { alignSelf: 'center' },
  stack: { gap: space.md },
  iconRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space.sm },
  card: { height: iconCard + space.md * 2, borderRadius: radius.lg, backgroundColor: color.surface },
  row: { height: tapMin + space.sm, borderRadius: radius.md, backgroundColor: color.surface },
  icon: { width: iconApp, height: iconApp, borderRadius: radius.lg, backgroundColor: color.surface },
});
