// S7 Thiết bị: danh sách (C11) tên · nền tảng · lần dùng cuối · nhãn "thiết bị này"; đăng xuất / thu hồi qua C9; đổi tên thiết bị này (C3).
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { runtime, useRuntime } from '../runtime';
import type { DeviceItem } from '../runtime/types';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Body, Screen } from '../ui/Layout';
import { ListGroup, ListRow } from '../ui/ListRow';
import { EmptyState, ErrorState, LoadingState } from '../ui/States';
import { TextField } from '../ui/TextField';
import { TitleBar } from '../ui/TitleBar';
import { codeOf, errorFrom } from '../ui/errorText';
import { formatWhen } from '../ui/format';
import { space } from '../ui/theme';
import { useBusy } from '../ui/useBusy';
import type { Nav } from './nav';

const NAME_MAX = 40;

export function DevicesScreen({ nav }: { nav: Nav }) {
  const rt = useRuntime();
  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [target, setTarget] = useState<DeviceItem | null>(null);
  const [dlgErr, setDlgErr] = useState<string | null>(null);
  const [revoking, runRevoke] = useBusy();
  const [name, setName] = useState('');
  const [nameDirty, setNameDirty] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [saving, runSave] = useBusy();

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const list = await runtime.listDevices();
      setDevices(list);
      const me = list.find((d) => d.isThisDevice);
      setName((prev) => (prev === '' && me ? me.name : prev));
    } catch (e) {
      setLoadErr(codeOf(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const offline = !rt.online;
  const me = devices?.find((d) => d.isThisDevice);

  const askRevoke = (d: DeviceItem) => {
    setDlgErr(null);
    setTarget(d);
  };
  const confirmRevoke = () =>
    runRevoke(async () => {
      if (!target) return;
      setDlgErr(null);
      try {
        await runtime.revokeDevice(target.id);
        const label = target.name;
        const wasMe = target.isThisDevice;
        setTarget(null);
        if (!wasMe) {
          runtime.pushToast({ kind: 'info', text: `Đã đăng xuất ${label}` });
          await load();
        }
      } catch (e) {
        setDlgErr(errorFrom(e));
      }
    });

  const save = () =>
    runSave(async () => {
      const v = name.trim();
      if (!v) {
        setNameErr('Tên thiết bị không được để trống.');
        return;
      }
      setNameErr(null);
      try {
        await runtime.renameThisDevice(v);
        setNameDirty(false);
        runtime.pushToast({ kind: 'info', text: 'Đã đổi tên thiết bị' });
        await load();
      } catch (e) {
        setNameErr(errorFrom(e));
      }
    });

  let list: React.ReactNode;
  if (devices === null && !loadErr) {
    list = <LoadingState kind="rows" count={3} />;
  } else if (loadErr) {
    list = <ErrorState code={loadErr} onRetry={() => void load()} />;
  } else if (devices) {
    list = (
      <>
        <ListGroup>
          {devices.map((d) => (
            <ListRow
              key={d.id}
              title={d.name}
              badge={d.isThisDevice ? 'thiết bị này' : undefined}
              subtitle={`${d.platform ?? 'Không rõ nền tảng'} · ${d.isThisDevice ? 'đang dùng' : `dùng lần cuối ${formatWhen(d.lastSeenAt)}`}`}
            >
              <Button
                title={d.isThisDevice ? 'Đăng xuất' : 'Đăng xuất máy đó'}
                accessibilityLabel={d.isThisDevice ? 'Đăng xuất khỏi máy này' : `Đăng xuất ${d.name}`}
                variant={d.isThisDevice ? 'secondary' : 'danger'}
                disabled={offline}
                onPress={() => askRevoke(d)}
              />
            </ListRow>
          ))}
        </ListGroup>
        {devices.length <= 1 ? <EmptyState glyph="▢" text="Chỉ có thiết bị này" /> : null}
      </>
    );
  }

  const pending = rt.pendingChanges;
  return (
    <Screen>
      <TitleBar title="Thiết bị" onBack={nav.back} />
      <Body>
        {offline ? <Banner tone="warning" text="Offline — không thu hồi thiết bị được (OFFLINE)" /> : null}
        {list}
        {me || devices === null ? (
          <View style={styles.rename}>
            <TextField
              label="Tên thiết bị này"
              value={name}
              onChangeText={(v) => {
                setName(v);
                setNameDirty(true);
                setNameErr(null);
              }}
              maxLength={NAME_MAX}
              error={nameErr}
              disabled={saving || !me}
              testID="device-name"
            />
            <Button
              title="Lưu tên"
              variant="secondary"
              busy={saving}
              busyTitle="Đang lưu…"
              disabled={!nameDirty || offline || !me}
              onPress={() => void save()}
            />
          </View>
        ) : null}
      </Body>

      <ConfirmDialog
        visible={!!target}
        title={target?.isThisDevice ? 'Đăng xuất?' : `Đăng xuất ${target?.name ?? ''}?`}
        message={
          target?.isThisDevice
            ? pending > 0
              ? `Còn ${pending} thay đổi chưa gửi. Thay đổi sẽ được giữ nếu đăng nhập lại cùng tài khoản.`
              : 'Máy này sẽ đăng xuất. Dữ liệu đã đồng bộ vẫn an toàn trên máy chủ.'
            : 'Máy đó sẽ bị đăng xuất ở lần kết nối tiếp theo. Dữ liệu chưa gửi trên máy đó được giữ tới khi đăng nhập lại.'
        }
        cancelLabel="Ở lại"
        confirmLabel={target?.isThisDevice ? 'Vẫn đăng xuất' : 'Đăng xuất máy đó'}
        busyLabel="Đang đăng xuất…"
        danger
        error={dlgErr}
        busy={revoking}
        onCancel={() => !revoking && setTarget(null)}
        onConfirm={() => void confirmRevoke()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  rename: { gap: space.sm },
});
