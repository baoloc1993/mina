// Khung màn hình dùng chung: nền bg, vùng cuộn với lề md và nhịp md giữa các khối (DESIGN-SYSTEM §2.3).
import React, { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type RefreshControlProps } from 'react-native';
import { Txt } from './Txt';
import { color, space } from './theme';
import { useKeyboardHeight } from './useKeyboardHeight';

export function Screen({ children }: { children: ReactNode }) {
  return <View style={styles.screen}>{children}</View>;
}

export function Body({
  children,
  refreshControl,
  scrollEnabled = true,
  footer,
  scrollEndOnKeyboard,
}: {
  children: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  scrollEnabled?: boolean;
  /** Khối cố định ở đáy (nút chính). */
  footer?: ReactNode;
  /** Màn có ô nhập ở cuối: mở bàn phím thì cuộn xuống cuối để ô + nút luôn thấy. */
  scrollEndOnKeyboard?: boolean;
}) {
  const ref = useRef<ScrollView>(null);
  const kb = useKeyboardHeight();
  useEffect(() => {
    if (!scrollEndOnKeyboard || kb === 0) return;
    const t = setTimeout(() => ref.current?.scrollToEnd({ animated: true }), 100);
    return () => clearTimeout(t);
  }, [kb, scrollEndOnKeyboard]);
  return (
    <>
      <ScrollView
        ref={ref}
        style={styles.flex}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        refreshControl={refreshControl}
        scrollEnabled={scrollEnabled}
      >
        {children}
      </ScrollView>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </>
  );
}

export function SectionTitle({ children }: { children: string }) {
  return (
    <Txt size="lg" weight="title" accessibilityRole="header">
      {children}
    </Txt>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },
  body: { padding: space.md, gap: space.md },
  footer: { padding: space.md, backgroundColor: color.bg },
});
