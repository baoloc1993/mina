// C11 hàng danh sách: mặc định · bấm được (chevron) · có nút nguy hiểm · nhãn "thiết bị này". Gói trong ListGroup (nền surface, bo lớn).
import React, { Children, Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Txt } from './Txt';
import { color, opacity, radius, space, stroke, tapMin } from './theme';

export function ListGroup({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <View style={styles.group}>
      {items.map((c, i) => (
        <Fragment key={i}>
          {i > 0 ? <View style={styles.sep} /> : null}
          {c}
        </Fragment>
      ))}
    </View>
  );
}

interface Props {
  title: string;
  subtitle?: string;
  /** Nhãn nhỏ cạnh tiêu đề (vd "thiết bị này"). */
  badge?: string;
  /** Giá trị / hành động bên phải. */
  right?: ReactNode;
  /** Có onPress ⇒ bấm được, hiện chevron. */
  onPress?(): void;
  disabled?: boolean;
  /** Khối bên dưới (nút nguy hiểm, chi tiết mở rộng). */
  children?: ReactNode;
  accessibilityLabel?: string;
  testID?: string;
}

export function ListRow({ title, subtitle, badge, right, onPress, disabled, children, accessibilityLabel, testID }: Props) {
  const head = (
    <View style={styles.head}>
      <View style={styles.text}>
        <View style={styles.titleRow}>
          <Txt weight="label" style={styles.titleText}>
            {title}
          </Txt>
          {badge ? (
            <View style={styles.badge}>
              <Txt size="sm" weight="label" tone="warning">
                {badge}
              </Txt>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Txt size="sm" tone="muted">
            {subtitle}
          </Txt>
        ) : null}
      </View>
      {right}
      {onPress ? (
        <Txt size="lg" tone="muted" accessibilityElementsHidden importantForAccessibility="no">
          ›
        </Txt>
      ) : null}
    </View>
  );
  return (
    <View testID={testID}>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? [title, subtitle].filter(Boolean).join('. ')}
          accessibilityState={{ disabled: !!disabled }}
          disabled={disabled}
          onPress={onPress}
          style={({ pressed }) => [styles.row, pressed && { opacity: opacity.pressed }, disabled && { opacity: opacity.disabled }]}
        >
          {head}
        </Pressable>
      ) : (
        <View style={styles.row}>{head}</View>
      )}
      {children ? <View style={styles.extra}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { backgroundColor: color.surface, borderRadius: radius.lg, overflow: 'hidden' },
  sep: { height: stroke.thin, backgroundColor: color.border, opacity: opacity.faint },
  row: { minHeight: tapMin, paddingVertical: space.sm, paddingHorizontal: space.md, justifyContent: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  text: { flex: 1, minWidth: 0, gap: space.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  titleText: { flexShrink: 1 },
  badge: { borderWidth: stroke.thin, borderColor: color.border, borderRadius: radius.md, paddingHorizontal: space.sm },
  extra: { paddingHorizontal: space.md, paddingBottom: space.sm, gap: space.sm },
});
