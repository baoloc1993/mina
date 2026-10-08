// S3 Catalog: thẻ app (C4), tiến trình cài (C12) ngay trên thẻ, banner offline, khuôn rỗng / lỗi / đang tải (C13), kéo xuống để làm mới.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl } from 'react-native';
import { runtime, useRuntime } from '../runtime';
import { AppCard } from '../ui/AppCard';
import { Banner } from '../ui/Banner';
import { Body, Screen } from '../ui/Layout';
import { SyncChip } from '../ui/SyncChip';
import { EmptyState, ErrorState, LoadingState } from '../ui/States';
import { TitleBar } from '../ui/TitleBar';
import { codeOf, errorFrom } from '../ui/errorText';
import { color } from '../ui/theme';
import type { Nav } from './nav';

export function CatalogScreen({ nav }: { nav: Nav }) {
  const rt = useRuntime();
  const { catalog, installing } = rt;
  const [timedOut, setTimedOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const prevInstalling = useRef<Set<string>>(new Set());

  useEffect(() => {
    runtime.refreshCatalog().catch(() => undefined);
  }, []);

  // Cài xong (hết tiến trình, không lỗi, app đã có trên launcher) ⇒ toast "Đã cài X · Mở?".
  useEffect(() => {
    const now = new Set(Object.keys(installing));
    prevInstalling.current.forEach((id) => {
      if (now.has(id)) return;
      const app = rt.apps.find((a) => a.app_id === id);
      if (app) {
        runtime.pushToast({ kind: 'info', text: `Đã cài ${app.name}`, action: { label: 'Mở', run: () => void runtime.openApp(id) } });
      }
    });
    prevInstalling.current = now;
  }, [installing, rt.apps]);

  useEffect(() => {
    if (!catalog.loading) setTimedOut(false);
  }, [catalog.loading]);

  const install = useCallback(async (id: string) => {
    try {
      await runtime.install(id);
    } catch (e) {
      // Lỗi cài đã hiện ở thẻ (C12) nếu runtime ghi vào `installing`; chỉ báo thêm khi chưa có.
      if (!runtime.getState().installing[id]?.error) runtime.pushToast({ kind: 'error', text: errorFrom(e) });
    }
  }, []);

  const open = (id: string) => {
    runtime.openApp(id).catch((e) => runtime.pushToast({ kind: 'error', text: errorFrom(e) }));
  };

  const retry = () => {
    setTimedOut(false);
    runtime.refreshCatalog().catch(() => undefined);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await runtime.refreshCatalog();
    } catch {
      // trạng thái lỗi nằm trong rt.catalog.error
    } finally {
      setRefreshing(false);
    }
  };

  const noItems = catalog.items.length === 0;
  let content: React.ReactNode;
  if (noItems && catalog.loading && !(timedOut && !rt.online)) {
    content = <LoadingState kind="cards" count={3} onTimeout={() => setTimedOut(true)} />;
  } else if (noItems && (catalog.error || (timedOut && !rt.online))) {
    const code = catalog.error ? codeOf(catalog.error) : 'OFFLINE';
    content = (
      <ErrorState
        code={code}
        text={code === 'OFFLINE' ? 'Không tải được catalog — đang offline' : undefined}
        onRetry={retry}
      />
    );
  } else if (noItems) {
    content = (
      <EmptyState
        text={rt.online ? 'Catalog trống — chưa có app nào được phát hành cho bạn' : 'Catalog trống — cần mạng để tải'}
        actionLabel={rt.online ? undefined : 'Thử lại'}
        onAction={rt.online ? undefined : retry}
      />
    );
  } else {
    content = catalog.items.map((item) => (
      <AppCard
        key={item.id}
        item={item}
        progress={installing[item.id]}
        fromCache={catalog.fromCache}
        onPress={() => nav.push({ name: 'detail', appId: item.id })}
        onInstall={() => void install(item.id)}
        onOpen={() => open(item.id)}
      />
    ));
  }

  return (
    <Screen>
      <TitleBar title="Catalog" onBack={nav.back} right={<SyncChip state={rt.sync.state} rejected={rt.sync.rejected} onPress={() => nav.push({ name: 'sync' })} />} />
      <Body refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} colors={[color.primary]} tintColor={color.primary} />}>
        {catalog.fromCache && !noItems ? <Banner tone="warning" text="Đang xem bản đã lưu — cần mạng để cài" /> : null}
        {catalog.error && !noItems && !(catalog.fromCache && codeOf(catalog.error) === 'OFFLINE') ?<Banner tone="warning" text={`Chưa làm mới được catalog (${codeOf(catalog.error)}) — đang xem bản đã lưu`} actionLabel="Thử lại" onAction={retry} /> : null}
        {content}
      </Body>
    </Screen>
  );
}
