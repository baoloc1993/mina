// S4 Chi tiết app: icon + tên + version, nút chính (Mở / Cài / Cập nhật), quyền dịch từ scope, Gỡ (giữ dữ liệu),
// và — chỉ khi app đã gỡ khỏi máy này mà còn dữ liệu — "Xoá hẳn dữ liệu" (gõ XOÁ).
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { runtime, useRuntime } from '../runtime';
import { AppIcon, iconUriOf } from '../ui/AppIcon';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { InstallProgress } from '../ui/InstallProgress';
import { Body, Screen, SectionTitle } from '../ui/Layout';
import { ListGroup, ListRow } from '../ui/ListRow';
import { ErrorState } from '../ui/States';
import { TitleBar } from '../ui/TitleBar';
import { Txt } from '../ui/Txt';
import { cardState } from '../ui/cardState';
import { PURGE_CONFIRM } from '../ui/confirmText';
import { errorFrom, errorSentence } from '../ui/errorText';
import { scopeLines } from '../ui/scopeText';
import { iconCard, radius, space } from '../ui/theme';
import { color } from '../ui/theme';
import { useBusy } from '../ui/useBusy';
import type { Nav } from './nav';

type Dlg = 'uninstall' | 'purge' | null;

export function AppDetailScreen({ appId, nav }: { appId: string; nav: Nav }) {
  const rt = useRuntime();
  const item = rt.catalog.items.find((i) => i.id === appId);
  const la = rt.apps.find((a) => a.app_id === appId);
  const local = la ?? item?.local ?? null;
  const progress = rt.installing[appId];
  const [dlg, setDlg] = useState<Dlg>(null);
  const [dlgErr, setDlgErr] = useState<string | null>(null);
  const [purged, setPurged] = useState(0);
  const [dlgBusy, runDlg] = useBusy();
  const [starting, setStarting] = useState(false);

  if (!item && !la) {
    return (
      <Screen>
        <TitleBar title="Chi tiết app" onBack={nav.back} />
        <Body>
          <ErrorState code="NOT_FOUND" text="Không tìm thấy app này trong catalog hoặc trên máy" onRetry={() => void runtime.refreshCatalog()} />
        </Body>
      </Screen>
    );
  }

  const name = la?.name ?? item?.name ?? appId;
  const installed = !!la;
  const removed = !installed && !!item?.uninstalledWithData;
  const state = item ? cardState(item, progress, rt.catalog.fromCache) : 'installed';
  const manifest = la?.manifest ?? null;
  const scopes = scopeLines(manifest?.scopes ?? item?.scopes, manifest?.network ?? item?.network);
  const description = manifest?.description ?? item?.description ?? null;
  const privateApp = !!item?.owner_tenant_id || !!la?.private_to_tenant;
  const running = la?.current_version ?? null;
  const offerVersion = item?.version ?? null;
  const offline = !rt.online;
  const isLive = rt.live.includes(appId);
  const busyInstall = starting && !progress;
  const revoked = !!la && (la.status === 'revoked' || la.blocked);

  const toastErr = (e: unknown) => runtime.pushToast({ kind: 'error', text: errorFrom(e) });
  const install = async () => {
    setStarting(true);
    try {
      await runtime.install(appId);
    } catch (e) {
      if (!runtime.getState().installing[appId]?.error) toastErr(e);
    } finally {
      setStarting(false);
    }
  };
  const open = () => {
    runtime.openApp(appId).catch(toastErr);
  };
  const closeDlg = () => {
    if (dlgBusy) return;
    setDlg(null);
    setDlgErr(null);
    setPurged(0);
  };
  const confirmUninstall = () =>
    runDlg(async () => {
      setDlgErr(null);
      try {
        await runtime.uninstall(appId);
        setDlg(null);
        runtime.pushToast({ kind: 'info', text: `Đã gỡ ${name}` });
      } catch (e) {
        setDlgErr(errorFrom(e));
      }
    });
  const confirmPurge = () =>
    runDlg(async () => {
      setDlgErr(null);
      setPurged(0);
      try {
        await runtime.purgeData(appId, (n) => setPurged(n));
        setDlg(null);
        runtime.pushToast({ kind: 'info', text: `Đã xoá dữ liệu của ${name}` });
      } catch (e) {
        setDlgErr(errorFrom(e));
      }
    });

  const offlineNote = rt.online ? undefined : 'Đang offline — cần mạng để thực hiện';

  return (
    <Screen>
      <TitleBar title={name} onBack={nav.back} />
      <Body>
        <View style={styles.head}>
          <AppIcon appId={appId} name={name} size={iconCard} privateApp={privateApp} iconUri={iconUriOf(local)} />
          <View style={styles.headText}>
            <Txt size="lg" weight="title">
              {name}
            </Txt>
            <Txt size="sm" tone="muted">
              {installed ? (isLive ? `Đang chạy bản ${running}` : `Đã cài · bản ${running}`) : offerVersion ? `Bản ${offerVersion}` : 'Chưa có bản để cài'}
              {removed && !progress && !starting ? ' · đã gỡ' : ''}
              {privateApp ? ' · riêng của bạn' : ''}
            </Txt>
            {la?.pending_version ? (
              <Txt size="sm" tone="primary">
                Bản {la.pending_version} sẽ chạy ở lần mở sau
              </Txt>
            ) : null}
          </View>
        </View>

        {revoked ? (
          <Banner
            tone="error"
            text={`Bản ${running} đã bị thu hồi — ${rt.online ? 'đang tải bản an toàn…' : 'cần mạng để cập nhật'} (APP_REVOKED)`}
          />
        ) : null}
        {la?.status === 'update_failed' ? (
          <Banner
            tone="error"
            text={`Cập nhật thất bại (UPDATE_FAILED) — bản ${running} vẫn chạy bình thường`}
            actionLabel="Chi tiết"
            onAction={() => nav.push({ name: 'sync' })}
          />
        ) : null}
        {!installed && rt.catalog.fromCache ? <Banner tone="warning" text="Đang xem bản đã lưu — cần mạng để cài" /> : null}

        {progress ? (
          <InstallProgress progress={progress} onRetry={() => void install()} />
        ) : installed ? (
          <>
            <Button title="Mở" onPress={open} testID="detail-open" />
            {item?.action === 'update' && !la?.pending_version ? (
              <Button title={`Cập nhật lên bản ${offerVersion ?? 'mới'}`} variant="secondary" busy={busyInstall} busyTitle="Đang cập nhật…" disabled={offline || rt.catalog.fromCache} onPress={() => void install()} />
            ) : null}
            {item?.action === 'update' && !la?.pending_version && (offline || rt.catalog.fromCache) ? (
              <Txt size="sm" tone="warning">
                Cần mạng để cài
              </Txt>
            ) : null}
            <Button title="Gỡ (giữ dữ liệu)" variant="secondary" onPress={() => setDlg('uninstall')} testID="detail-uninstall" />
          </>
        ) : (
          <>
            <Button
              title={removed ? 'Cài lại' : 'Cài'}
              busy={busyInstall}
              busyTitle="Đang cài…"
              disabled={offline || state === 'unsafe' || state === 'quota' || state === 'cache-offline'}
              onPress={() => void install()}
              testID="detail-install"
            />
            {state === 'unsafe' ? (
              <Txt size="sm" tone="danger">
                {errorSentence(item?.code === 'PACKAGE_UNAVAILABLE' ? 'PACKAGE_UNAVAILABLE' : 'NO_SAFE_VERSION')} ({item?.code === 'PACKAGE_UNAVAILABLE' ? 'PACKAGE_UNAVAILABLE' : 'NO_SAFE_VERSION'})
              </Txt>
            ) : null}
            {offline || state === 'cache-offline' ? (
              <Txt size="sm" tone="warning">
                Cần mạng để cài
              </Txt>
            ) : null}
            {state === 'quota' ? (
              <Txt size="sm" tone="warning">
                {errorSentence('QUOTA_EXCEEDED')} (QUOTA_EXCEEDED)
              </Txt>
            ) : null}
            {removed ? (
              <View style={styles.purge}>
                <Button title="Xoá hẳn dữ liệu" variant="dangerOutline" onPress={() => setDlg('purge')} testID="detail-purge" />
                <Txt size="sm" tone="muted">
                  Dữ liệu vẫn còn trên máy chủ — cài lại sẽ thấy đủ. Xoá hẳn thì không lấy lại được.
                </Txt>
              </View>
            ) : null}
          </>
        )}

        {scopes.length > 0 ? (
          <>
            <SectionTitle>App này dùng</SectionTitle>
            <ListGroup>
              {scopes.map((s) => (
                <ListRow key={s} title={s} />
              ))}
            </ListGroup>
          </>
        ) : null}
        {description ? (
          <Txt size="sm" tone="muted">
            {description}
          </Txt>
        ) : null}
      </Body>

      <ConfirmDialog
        visible={dlg === 'uninstall'}
        title={`Gỡ ${name} khỏi máy này?`}
        message="Dữ liệu vẫn còn trên máy chủ, cài lại là thấy đủ."
        notice={offlineNote}
        error={dlgErr}
        confirmLabel="Gỡ"
        busyLabel="Đang gỡ…"
        busy={dlgBusy}
        onCancel={closeDlg}
        onConfirm={() => void confirmUninstall()}
      />
      <ConfirmDialog
        visible={dlg === 'purge'}
        title={`Xoá hẳn dữ liệu của ${name}?`}
        message="Mọi dữ liệu của app trên máy chủ sẽ bị xoá và không lấy lại được."
        notice={dlgBusy ? `Đang xoá… đã xử lý ${purged} dòng` : offlineNote}
        error={dlgErr}
        confirmLabel="Xoá hẳn"
        busyLabel="Đang xoá…"
        danger
        requireText={PURGE_CONFIRM}
        busy={dlgBusy}
        onCancel={closeDlg}
        onConfirm={() => void confirmPurge()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', gap: space.md, padding: space.md, borderRadius: radius.lg, backgroundColor: color.surface, alignItems: 'center' },
  purge: { gap: space.sm, marginTop: space.lg },
  headText: { flex: 1, gap: space.xs },
});
