// C4 thẻ app trong catalog. Bảy trạng thái: cài được · đã cài · có bản mới · đang tải (C12) · không có bản an toàn (danger) ·
// hết quota (nút tắt + gợi ý) · chỉ bản cache offline (nút tắt + "cần mạng để cài").
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppIcon, iconUriOf } from './AppIcon';
import { Button } from './Button';
import { InstallProgress } from './InstallProgress';
import { Txt } from './Txt';
import { errorSentence } from './errorText';
import { cardState } from './cardState';
import { color, iconCard, opacity, radius, space, stroke } from './theme';
import type { CatalogItem, InstallProgress as Progress } from '../runtime/types';

interface Props {
  item: CatalogItem;
  progress?: Progress;
  fromCache: boolean;
  onPress(): void;
  onInstall(): void;
  onOpen(): void;
  /** Vừa bấm Cài/Cập nhật, tiến trình thật chưa về: hiện "Đang cài…" ngay. */
  starting?: boolean;
}

export function AppCard({ item, progress, fromCache, onPress, onInstall, onOpen, starting }: Props) {
  const state = cardState(item, progress, fromCache);
  const busyInstall = !!starting && !progress;
  const privateApp = !!item.owner_tenant_id;
  const unsafe = state === 'unsafe';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.name}. ${item.description ?? ''}`.trim()}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: opacity.pressed }]}
    >
      <AppIcon appId={item.id} name={item.name} size={iconCard} privateApp={privateApp} iconUri={iconUriOf(item.local)} style={styles.top} />
      <View style={styles.meta}>
        <View style={styles.nameRow}>
          <Txt size="lg" weight="title" tone={unsafe ? 'danger' : 'text'} style={styles.name}>
            {item.name}
          </Txt>
        </View>
        {privateApp ? (
          <View style={styles.tag}>
            <Txt size="sm" weight="label" tone="warning">
              riêng của bạn
            </Txt>
          </View>
        ) : null}
        {item.description ? (
          <Txt size="sm" tone="muted" numberOfLines={3}>
            {item.description}
          </Txt>
        ) : null}
        {unsafe ? (
          <Txt size="sm" tone="danger">
            {errorSentence(item.code === 'PACKAGE_UNAVAILABLE' ? 'PACKAGE_UNAVAILABLE' : 'NO_SAFE_VERSION')} (
            {item.code === 'PACKAGE_UNAVAILABLE' ? 'PACKAGE_UNAVAILABLE' : 'NO_SAFE_VERSION'})
          </Txt>
        ) : null}
        {state === 'removed' || item.uninstalledWithData ? (
          <Txt size="sm" tone="muted">
            Đã gỡ khỏi máy này · dữ liệu vẫn còn trên máy chủ
          </Txt>
        ) : null}
        <View style={styles.act}>
          {state === 'installing' && progress ? (
            <InstallProgress progress={progress} onRetry={onInstall} />
          ) : state === 'unsafe' ? (
            <Button title="Cài" variant="secondary" disabled compact onPress={onInstall} />
          ) : state === 'quota' ? (
            <>
              <Button title="Cài" disabled compact onPress={onInstall} />
              <Txt size="sm" tone="warning">
                {errorSentence('QUOTA_EXCEEDED')} (QUOTA_EXCEEDED)
              </Txt>
            </>
          ) : state === 'cache-offline' ? (
            <>
              <Button title={item.action === 'update' ? 'Cập nhật' : 'Cài'} disabled compact onPress={onInstall} />
              <Txt size="sm" tone="warning">
                Cần mạng để cài
              </Txt>
            </>
          ) : state === 'installed' ? (
            <View style={styles.inline}>
              <Txt size="sm" weight="label" tone="success">
                Đã cài
              </Txt>
              <Button title="Mở" variant="secondary" compact onPress={onOpen} />
            </View>
          ) : state === 'pending-update' ? (
            <>
              <Button title="Mở" variant="secondary" compact onPress={onOpen} />
              <Txt size="sm" tone="primary">
                Bản {item.local?.pending_version} sẽ chạy ở lần mở sau
              </Txt>
            </>
          ) : state === 'update' ? (
            <Button title="Cập nhật" busy={busyInstall} busyTitle="Đang cập nhật…" compact onPress={onInstall} />
          ) : (
            <Button title={state === 'removed' ? 'Cài lại' : 'Cài'} busy={busyInstall} busyTitle="Đang cài…" compact onPress={onInstall} />
          )}
        </View>
      </View>
      <Txt size="lg" tone="muted" accessibilityElementsHidden importantForAccessibility="no">
        ›
      </Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', gap: space.md, padding: space.md, borderRadius: radius.lg, backgroundColor: color.surface, alignItems: 'center' },
  meta: { flex: 1, minWidth: 0, gap: space.xs },
  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  name: { flexShrink: 1 },
  tag: { alignSelf: 'flex-start', borderWidth: stroke.thin, borderColor: color.border, borderRadius: radius.md, paddingHorizontal: space.sm },
  top: { alignSelf: 'flex-start' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  act: { marginTop: space.sm, gap: space.xs, alignSelf: 'stretch' },
});
