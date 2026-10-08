// S6 Đồng bộ & lỗi: trạng thái lớn + số thay đổi đang chờ + lần sync cuối; danh sách thay đổi bị từ chối (C11) bấm xem JSON; "Thử đồng bộ lại".
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { runtime, useRuntime } from '../runtime';
import type { RejectionRow } from '../runtime/types';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Body, Screen, SectionTitle } from '../ui/Layout';
import { ListGroup, ListRow } from '../ui/ListRow';
import { chipInfo } from '../ui/SyncChip';
import { EmptyState } from '../ui/States';
import { TitleBar } from '../ui/TitleBar';
import { Txt } from '../ui/Txt';
import { errorFrom, errorSentence } from '../ui/errorText';
import { formatWhen, pendingText } from '../ui/format';
import { color, monoFamily, radius, space, stroke } from '../ui/theme';
import { useBusy } from '../ui/useBusy';
import type { Nav } from './nav';
import { rejectionTitle } from './text';

export function SyncScreen({ nav }: { nav: Nav }) {
  const rt = useRuntime();
  const [open, setOpen] = useState<string | null>(null);
  const [retrying, runRetry] = useBusy();

  useEffect(() => {
    void runtime.markRejectionsSeen();
  }, []);

  const nameOf = (id: string | null) => (id ? (rt.apps.find((a) => a.app_id === id)?.name ?? id) : 'Hệ thống');
  const offline = rt.sync.state === 'offline';

  const retry = () =>
    runRetry(async () => {
      try {
        await runtime.retrySync();
      } catch (e) {
        runtime.pushToast({ kind: 'error', text: errorFrom(e) });
      }
    });

  return (
    <Screen>
      <TitleBar title="Đồng bộ" onBack={nav.back} />
      <Body>
        <View style={styles.status}>
          <Txt size="xl" weight="title" tone={chipInfo(rt.sync.state, rt.sync.rejected).tone} accessibilityRole="header">
            {chipInfo(rt.sync.state, rt.sync.rejected).text}
          </Txt>
          <Txt weight="label">{pendingText(rt.pendingChanges)}</Txt>
          {rt.pendingFiles > 0 ? <Txt size="sm" tone="muted">{`${rt.pendingFiles} tệp chưa tải lên`}</Txt> : null}
          <Txt size="sm" tone="muted">
            Đồng bộ lần cuối: {formatWhen(rt.sync.lastSyncedAt)}
          </Txt>
        </View>

        {rt.entitlement.readOnly ? (
          <Banner tone="warning" text="Chỉ đọc: thay đổi được giữ lại, không mất — sẽ gửi khi xác minh lại gói (READ_ONLY)" />
        ) : null}

        <SectionTitle>Bị từ chối</SectionTitle>
        {rt.rejections.length === 0 ? (
          <EmptyState glyph="✓" text="Không có thay đổi nào bị từ chối" />
        ) : (
          <ListGroup>
            {rt.rejections.map((r) => {
              const expanded = open === r.id;
              return (
                <ListRow
                  key={r.id}
                  title={rejectionTitle(r, nameOf(r.app))}
                  subtitle={`${r.code} · ${formatWhen(r.createdAt)}${r.detail ? ` · ${r.detail}` : ''}`}
                  onPress={() => setOpen(expanded ? null : r.id)}
                  accessibilityLabel={`${rejectionTitle(r, nameOf(r.app))}. ${errorSentence(r.code)}. ${expanded ? 'Đang mở chi tiết' : 'Chạm để xem chi tiết'}`}
                >
                  {expanded ? (
                    <View style={styles.json}>
                      <Txt size="sm" tone="muted">
                        {errorSentence(r.code)}
                      </Txt>
                      <Txt size="sm" style={styles.mono} selectable>
                        {r.data ?? '(không có dữ liệu đính kèm)'}
                      </Txt>
                    </View>
                  ) : null}
                </ListRow>
              );
            })}
          </ListGroup>
        )}

        <Button
          title="Thử đồng bộ lại"
          variant="secondary"
          busy={retrying}
          busyTitle="Đang đồng bộ lại…"
          disabled={offline}
          onPress={() => void retry()}
          testID="sync-retry"
        />
        {offline ? (
          <Txt size="sm" tone="warning">
            Đang offline — cần mạng để đồng bộ (OFFLINE)
          </Txt>
        ) : null}
      </Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  status: { gap: space.xs, padding: space.md, borderRadius: radius.lg, backgroundColor: color.surface, alignItems: 'flex-start' },
  json: { padding: space.sm, gap: space.xs, borderRadius: radius.md, backgroundColor: color.bg, borderWidth: stroke.thin, borderColor: color.border },
  mono: { fontFamily: monoFamily },
});
