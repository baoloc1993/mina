// S8 Tài khoản: email + gói (+ ân hạn), banner chỉ đọc, Liên kết Google / Apple, → S7 Thiết bị, → S6 Đồng bộ, Đăng xuất.
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { runtime, useRuntime } from '../runtime';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Body, Screen } from '../ui/Layout';
import { ListGroup, ListRow } from '../ui/ListRow';
import { chipInfo } from '../ui/SyncChip';
import { TitleBar } from '../ui/TitleBar';
import { Txt } from '../ui/Txt';
import { codeOf, errorFrom, errorText } from '../ui/errorText';
import { formatGraceLeft } from '../ui/format';
import { color, radius, space } from '../ui/theme';
import { useBusy } from '../ui/useBusy';
import type { Nav } from './nav';
import { planLine } from './text';

export function AccountScreen({ nav }: { nav: Nav }) {
  const rt = useRuntime();
  const [providerBusy, runProvider] = useBusy();
  const [which, setWhich] = useState<'google' | 'apple' | null>(null);
  const [verifying, runVerify] = useBusy();
  const [outBusy, runOut] = useBusy();
  const [signingOut, runSigningOut] = useBusy();
  const [pending, setPending] = useState<number | null>(null);
  const [outErr, setOutErr] = useState<string | null>(null);

  const ent = rt.entitlement;
  const graceText = ent.expired && !ent.readOnly && ent.graceLeftMs !== null ? `Gói đã quá hạn — ${formatGraceLeft(ent.graceLeftMs)} ân hạn` : null;

  const link = (p: 'google' | 'apple') =>
    runProvider(async () => {
      setWhich(p);
      try {
        await runtime.linkProvider(p);
        runtime.pushToast({ kind: 'info', text: `Đã liên kết ${p === 'google' ? 'Google' : 'Apple'}` });
      } catch (e) {
        runtime.pushToast({
          kind: 'error',
          text: codeOf(e) === 'PROVIDER_UNAVAILABLE' ? errorText('PROVIDER_UNAVAILABLE', { provider: p === 'google' ? 'Google' : 'Apple' }) : errorFrom(e),
        });
      }
    });

  const verifyAgain = () =>
    runVerify(async () => {
      try {
        await runtime.refreshCatalog();
        if (runtime.getState().entitlement.readOnly) {
          runtime.pushToast({ kind: 'error', text: errorText(runtime.getState().online ? 'READ_ONLY' : 'OFFLINE') });
        } else {
          runtime.pushToast({ kind: 'info', text: 'Đã xác minh lại — hết chỉ đọc' });
        }
      } catch (e) {
        runtime.pushToast({ kind: 'error', text: errorFrom(e) });
      }
    });

  const signOut = () =>
    runSigningOut(async () => {
      setOutErr(null);
      try {
        const r = await runtime.signOut();
        if (!r.done) setPending(r.pending);
      } catch (e) {
        runtime.pushToast({ kind: 'error', text: errorFrom(e) });
      }
    });

  const forceOut = () =>
    runOut(async () => {
      setOutErr(null);
      try {
        await runtime.signOut(true);
        setPending(null);
      } catch (e) {
        setOutErr(errorFrom(e));
      }
    });

  return (
    <Screen>
      <TitleBar title="Tài khoản" onBack={nav.back} />
      <Body>
        <View style={styles.card}>
          <Txt weight="title" accessibilityRole="header">
            {rt.session?.email ?? 'Chưa rõ email'}
          </Txt>
          <Txt size="sm" tone="muted">
            {planLine(rt.plan)}
          </Txt>
          {graceText ? (
            <Txt size="sm" tone="warning">
              {graceText}
            </Txt>
          ) : null}
          {ent.readOnly ? (
            <Txt size="sm" tone="warning">
              Đã quá ân hạn
            </Txt>
          ) : null}
        </View>

        {ent.readOnly ? (
          <Banner
            tone="warning"
            text="Chỉ đọc — cần mạng để xác minh lại gói. Dữ liệu không mất."
            actionLabel={verifying ? 'Đang xác minh…' : 'Xác minh'}
            onAction={() => !verifying && void verifyAgain()}
          />
        ) : null}

        <ListGroup>
          <ListRow title="Thiết bị" subtitle="Các máy đang đăng nhập" onPress={() => nav.push({ name: 'devices' })} />
          <ListRow title="Đồng bộ" subtitle={chipInfo(rt.sync.state, rt.sync.rejected).text} onPress={() => nav.push({ name: 'sync' })} />
          <ListRow
            title="Liên kết Google"
            subtitle={providerBusy && which === 'google' ? 'Đang mở…' : 'Đăng nhập nhanh hơn, cùng tài khoản'}
            disabled={providerBusy}
            onPress={() => void link('google')}
          />
          <ListRow
            title="Liên kết Apple"
            subtitle={providerBusy && which === 'apple' ? 'Đang mở…' : 'Chỉ bắt buộc trên iPhone'}
            disabled={providerBusy}
            onPress={() => void link('apple')}
          />
        </ListGroup>

        <Button title="Đăng xuất" variant="secondary" busy={signingOut} busyTitle="Đang kiểm tra…" onPress={() => void signOut()} testID="account-signout" />
      </Body>

      <ConfirmDialog
        visible={pending !== null}
        title="Còn thay đổi chưa gửi"
        message={`Còn ${pending ?? 0} thay đổi chưa gửi. Thay đổi sẽ được giữ trên máy nếu bạn đăng nhập lại cùng tài khoản; đổi sang tài khoản khác sẽ làm mất chúng.`}
        cancelLabel="Ở lại"
        confirmLabel="Vẫn đăng xuất"
        busyLabel="Đang đăng xuất…"
        danger
        error={outErr}
        busy={outBusy}
        onCancel={() => !outBusy && setPending(null)}
        onConfirm={() => void forceOut()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.xs, padding: space.md, borderRadius: radius.lg, backgroundColor: color.surface },
});
