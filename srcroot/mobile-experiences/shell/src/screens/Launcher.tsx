// S2 Launcher: lưới 4 cột (C5), chạm mở, giữ-kéo sắp xếp, chip sync (C6), nút Catalog, nút tài khoản, banner C8.
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { runtime, useRuntime } from '../runtime';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { DragGrid } from '../ui/DragGrid';
import { Glyph } from '../ui/Glyph';
import { Body, Screen } from '../ui/Layout';
import { LauncherIcon } from '../ui/LauncherIcon';
import { SyncChip } from '../ui/SyncChip';
import { EmptyState } from '../ui/States';
import { TitleBar } from '../ui/TitleBar';
import { Txt } from '../ui/Txt';
import { errorFrom } from '../ui/errorText';
import { space, tapMin } from '../ui/theme';
import type { Nav } from './nav';
import { readOnlyBannerText, rejectionBannerText } from './text';

interface Note {
  key: string;
  tone: 'warning' | 'error' | 'info';
  text: string;
  actionLabel?: string;
  onAction?(): void;
  onPress?(): void;
}

export function LauncherScreen({ nav }: { nav: Nav }) {
  const rt = useRuntime();
  const [dragging, setDragging] = useState(false);

  const updated = rt.apps.filter((a) => a.notice === 'updated');
  const pending = rt.apps.filter((a) => a.updatePending && a.notice !== 'updated');
  const removedElsewhere = rt.apps.filter((a) => a.removedElsewhere);
  const rejected = rt.sync.rejected > 0 ? rt.sync.rejected : rt.unseenRejections;
  const initial = (rt.session?.email ?? '?').trim().charAt(0).toUpperCase() || '?';

  const open = (id: string) => {
    runtime.openApp(id).catch((e) => runtime.pushToast({ kind: 'error', text: errorFrom(e) }));
  };

  // Tối đa 2 banner cùng lúc ở màn thấp: 1 banner ưu tiên cao nhất + dòng "+N thông báo" nếu còn nhiều hơn.
  const notes: Note[] = [];
  if (rejected > 0) notes.push({ key: 'rej', tone: 'error', text: rejectionBannerText(rejected, rt.rejections), onPress: () => nav.push({ name: 'sync' }) });
  if (rt.entitlement.readOnly) notes.push({ key: 'ro', tone: 'warning', text: readOnlyBannerText(rt.entitlement.reason), onPress: () => nav.push({ name: 'account' }) });
  updated.forEach((a) =>
    notes.push({ key: `u-${a.app_id}`, tone: 'info', text: `${a.name} đã lên ${a.current_version}`, actionLabel: 'Đóng', onAction: () => void runtime.dismissNotice(a.app_id) }),
  );
  pending.forEach((a) => notes.push({ key: `p-${a.app_id}`, tone: 'info', text: `${a.name}: bản ${a.pending_version ?? 'mới'} chạy ở lần mở sau` }));
  removedElsewhere.forEach((a) => notes.push({ key: `r-${a.app_id}`, tone: 'warning', text: `${a.name} đã gỡ ở máy khác` }));
  const shown = notes.length > 2 ? notes.slice(0, 1) : notes;
  const extra = notes.length > 2 ? notes.length - 1 : 0;

  return (
    <Screen>
      <TitleBar
        title="Mina"
        right={
          <>
            <SyncChip state={rt.sync.state} rejected={rt.sync.rejected} onPress={() => nav.push({ name: 'sync' })} testID="launcher-chip" />
            <Pressable
              testID="launcher-account"
              accessibilityRole="button"
              accessibilityLabel="Tài khoản"
              onPress={() => nav.push({ name: 'account' })}
              style={styles.account}
            >
              <Glyph char={initial} tone="primary" size={tapMin - space.md} />
            </Pressable>
          </>
        }
      />
      <Body
        scrollEnabled={!dragging}
        footer={<Button title="＋ Catalog" onPress={() => nav.push({ name: 'catalog' })} testID="launcher-catalog" />}
      >
        {shown.map((n) => (
          <Banner key={n.key} tone={n.tone} text={n.text} actionLabel={n.actionLabel} onAction={n.onAction} onPress={n.onPress} />
        ))}
        {extra > 0 ? (
          <Banner tone="info" text={`+${extra} thông báo`} onPress={() => nav.push({ name: rejected > 0 ? 'sync' : 'account' })} />
        ) : null}

        {rt.apps.length === 0 ? (
          <EmptyState text="Chưa cài app nào" actionLabel="Mở catalog" onAction={() => nav.push({ name: 'catalog' })} />
        ) : (
          <>
            <DragGrid
              items={rt.apps}
              onDragChange={setDragging}
              onPressItem={(a) => open(a.app_id)}
              onReorder={(ids) => runtime.reorder(ids)}
              renderItem={(a, isDragging, handlers) => <LauncherIcon app={a} dragging={isDragging} handlers={handlers} />}
            />
            {rt.apps.length > 1 ? (
              <Txt size="sm" tone="muted" center>
                {dragging ? 'Kéo tới vị trí mới rồi thả tay' : 'Giữ icon rồi kéo để sắp xếp'}
              </Txt>
            ) : null}
          </>
        )}
      </Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  account: { width: tapMin, height: tapMin, alignItems: 'center', justifyContent: 'center' },
});
