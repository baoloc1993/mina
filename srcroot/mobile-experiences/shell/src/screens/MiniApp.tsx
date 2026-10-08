// S5 Mini app: KHUNG — thanh C7 (tên app + chip C6 + ×) + vùng nội dung do <LiveApps /> lấp đầy + banner chỉ đọc + màn chặn mở (C14).
// Toast C10 vẽ ở gốc (Router). BACK hệ thống ⇒ closeForeground() (Router lo).
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { runtime, useRuntime } from '../runtime';
import { LiveApps } from '../webview/LiveApps';
import { AppFrame } from '../ui/AppFrame';
import { Screen } from '../ui/Layout';
import { SyncChip } from '../ui/SyncChip';
import { TitleBar } from '../ui/TitleBar';
import { Txt } from '../ui/Txt';
import { chipHeight, color, radius, space, stroke } from '../ui/theme';

export function MiniAppScreen() {
  const rt = useRuntime();
  const blocked = rt.blockedOpen;
  const fgId = rt.foreground;
  const fgApp = rt.apps.find((a) => a.app_id === fgId);
  const title = blocked ? blocked.name : (fgApp?.name ?? fgId ?? '');
  const close = () => (blocked ? runtime.dismissBlockedOpen() : runtime.closeForeground());

  return (
    <Screen>
      <TitleBar
        title={title}
        onClose={close}
        right={<SyncChip state={rt.sync.state} rejected={rt.sync.rejected} />}
      />
      <AppFrame
        readOnly={rt.entitlement.readOnly && !blocked}
        blocked={blocked ? { name: blocked.name, message: blocked.message, onClose: close } : null}
      >
        <LiveApps style={styles.live} />
      </AppFrame>
      {rt.live.length >= 2 ? (
        <View style={styles.lives} accessibilityLabel={`App đang chạy: ${rt.live.length} trên 3`}>
          <Txt size="sm" tone="muted">
            App đang chạy:
          </Txt>
          {rt.live.map((id) => {
            const a = rt.apps.find((x) => x.app_id === id);
            const on = id === fgId;
            return (
              <View key={id} style={[styles.pill, on && styles.pillOn]}>
                <Txt size="sm" weight="label" tone={on ? 'primary' : 'muted'}>
                  {a?.name ?? id}
                </Txt>
              </View>
            );
          })}
          <Txt size="sm" tone="muted">
            {rt.live.length}/3
          </Txt>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  live: { flex: 1 },
  lives: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.xs },
  pill: { minHeight: chipHeight - space.sm, paddingHorizontal: space.sm, justifyContent: 'center', borderRadius: radius.md, borderWidth: stroke.thin, borderColor: color.border },
  pillOn: { borderColor: color.primary },
});
