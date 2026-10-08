// C14 khung mini app: splash (icon app + "Đang mở…") · đã ready · bị chặn mở (bản thu hồi, cần mạng) · chỉ đọc (banner C8 trên cùng).
// Vùng WebView do `<LiveApps />` của runtime lấp đầy (children); splash cũng export để LiveApps dùng lúc nạp.
import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppIcon } from './AppIcon';
import { Banner } from './Banner';
import { Button } from './Button';
import { Glyph } from './Glyph';
import { Txt } from './Txt';
import { errorSentence } from './errorText';
import { color, glyphBig, space } from './theme';

export function AppSplash({ appId, name, privateApp }: { appId: string; name: string; privateApp?: boolean }) {
  return (
    <View style={styles.fill} accessibilityRole="progressbar" accessibilityLabel={`Đang mở ${name}`}>
      <AppIcon appId={appId} name={name} privateApp={privateApp} />
      <Txt tone="muted">Đang mở…</Txt>
    </View>
  );
}

export function BlockedOpen({ name, message, onClose }: { name: string; message?: string; onClose(): void }) {
  return (
    <View style={styles.fill} accessibilityRole="alert">
      <Glyph char="!" tone="danger" size={glyphBig} />
      <Txt size="lg" weight="title" tone="danger" center>
        Bản này đã bị thu hồi
      </Txt>
      <Txt center>{message ?? `${errorSentence('APP_REVOKED')}.`}</Txt>
      <Txt size="sm" tone="muted" center>
        {name} (APP_REVOKED)
      </Txt>
      <Button title="Đóng" variant="secondary" compact onPress={onClose} style={{ alignSelf: 'center' }} />
    </View>
  );
}

interface FrameProps {
  readOnly?: boolean;
  /** Màn chặn mở phủ lên toàn khung. */
  blocked?: { name: string; message?: string; onClose(): void } | null;
  children?: ReactNode;
}

export function AppFrame({ readOnly, blocked, children }: FrameProps) {
  return (
    <View style={styles.frame}>
      {readOnly ? (
        <View style={styles.banner}>
          <Banner tone="warning" text="Chỉ đọc — thay đổi sẽ được giữ và gửi khi xác minh lại" />
        </View>
      ) : null}
      <View style={styles.frame}>{children}</View>
      {blocked ? (
        <View style={[StyleSheet.absoluteFill, styles.block]}>
          <BlockedOpen {...blocked} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: color.bg },
  banner: { paddingHorizontal: space.md, paddingBottom: space.sm },
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.lg, backgroundColor: color.bg },
  block: { backgroundColor: color.bg },
});
