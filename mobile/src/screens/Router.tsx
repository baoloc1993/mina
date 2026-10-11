// Điều hướng bằng state (stack) theo PROTOTYPE.md §2. Quyết S1 / S5 theo RuntimeState:
//   boot ≠ ready → màn khởi động · session = null → S1 (kể cả 401 giữa chừng: runtime tự đặt session = null, hàng đợi giữ)
//   foreground / blockedOpen → S5 phủ lên stack hiện tại (stack giữ nguyên để BACK quay lại đúng màn trước).
// <LiveApps /> giữ mounted suốt phiên (WebView sống tối đa 3), chỉ ẩn khi đang ở launcher.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { runtime, useRuntime } from '../runtime';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Screen } from '../ui/Layout';
import { ErrorState, Pulse } from '../ui/States';
import { ToastHost } from '../ui/Toast';
import { Txt } from '../ui/Txt';
import { color, space } from '../ui/theme';
import { AccountScreen } from './Account';
import { AppDetailScreen } from './AppDetail';
import { CatalogScreen } from './Catalog';
import { DevicesScreen } from './Devices';
import { LauncherScreen } from './Launcher';
import { LoginScreen } from './Login';
import { MiniAppScreen } from './MiniApp';
import { SyncScreen } from './SyncScreen';
import { popRoute, pushRoute, type Nav, type Route } from './nav';

const HOME: Route[] = [{ name: 'launcher' }];

function BootScreen({ error }: { error: string | null }) {
  if (error !== null) {
    return (
      <Screen>
        <View style={styles.center}>
          <ErrorState code="INTERNAL" text={error || 'Không khởi động được Mina. Thử mở lại ứng dụng.'} />
        </View>
      </Screen>
    );
  }
  return (
    <Screen>
      <View style={styles.center}>
        <Pulse>
          <Txt size="xl" weight="title" center>
            Mina
          </Txt>
        </Pulse>
        <Txt tone="muted" center>
          Đang khởi động…
        </Txt>
      </View>
    </Screen>
  );
}

export function Router() {
  const rt = useRuntime();
  const [stack, setStack] = useState<Route[]>(HOME);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const signedIn = !!rt.session;

  const nav: Nav = useMemo(
    () => ({
      push: (r) => setStack((s) => pushRoute(s, r)),
      back: () => setStack((s) => popRoute(s) ?? s),
    }),
    [],
  );

  // Mở mini app (từ bất kỳ màn nào) rồi ×/BACK ⇒ về launcher theo prototype: đặt lại stack khi foreground null → có giá trị.
  const fg = rt.foreground;
  const prevFg = useRef<string | null>(null);
  useEffect(() => {
    if (prevFg.current === null && fg !== null) setStack(HOME);
    prevFg.current = fg;
  }, [fg]);

  // Đăng xuất / hết phiên: về gốc để lần đăng nhập sau bắt đầu từ launcher.
  useEffect(() => {
    if (!signedIn) setStack(HOME);
  }, [signedIn]);

  // BACK vật lý: đóng hộp chặn / mini app → quay màn trước → ở gốc thì để hệ thống thoát shell.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const s = runtime.getState();
      if (!s.session) return false;
      if (s.blockedOpen) {
        runtime.dismissBlockedOpen();
        return true;
      }
      if (s.opening && !s.foreground) return true; // đang chuẩn bị mở: nuốt BACK, tránh lệch trạng thái
      if (s.foreground) {
        runtime.closeForeground();
        return true;
      }
      const popped = popRoute(stackRef.current);
      if (popped) {
        setStack(popped);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  let body: React.ReactNode;
  if (rt.boot !== 'ready') {
    body = <BootScreen error={rt.boot === 'error' ? (rt.bootError ?? '') : null} />;
  } else if (!signedIn) {
    body = <LoginScreen />;
  } else {
    const top = stack[stack.length - 1];
    const showApp = rt.foreground !== null || rt.blockedOpen !== null || rt.opening !== null;
    let screen: React.ReactNode;
    switch (top.name) {
      case 'catalog':
        screen = <CatalogScreen nav={nav} />;
        break;
      case 'detail':
        screen = <AppDetailScreen key={top.appId} appId={top.appId} nav={nav} />;
        break;
      case 'sync':
        screen = <SyncScreen nav={nav} />;
        break;
      case 'devices':
        screen = <DevicesScreen nav={nav} />;
        break;
      case 'account':
        screen = <AccountScreen nav={nav} />;
        break;
      default:
        screen = <LauncherScreen nav={nav} />;
    }
    body = (
      <>
        <View style={styles.flex} importantForAccessibility={showApp ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={showApp}>
          {screen}
        </View>
        <View
          style={[StyleSheet.absoluteFill, showApp ? styles.appOn : styles.appOff]}
          pointerEvents={showApp ? 'auto' : 'none'}
          importantForAccessibility={showApp ? 'auto' : 'no-hide-descendants'}
        >
          <MiniAppScreen />
        </View>
      </>
    );
  }

  return (
    <View style={styles.root}>
      {body}
      <ConfirmDialog
        visible={!!rt.accessPrompt}
        title={rt.accessPrompt ? `Cho phép ${rt.accessPrompt.appName} truy cập ${rt.accessPrompt.host}?` : ''}
        message={rt.accessPrompt ? (rt.accessPrompt.reason ?? `${rt.accessPrompt.appName} muốn tải dữ liệu từ ${rt.accessPrompt.host}.`) : undefined}
        notice="Bạn có thể thu hồi lại trong chi tiết app."
        confirmLabel="Cho phép"
        cancelLabel="Không"
        onCancel={() => runtime.answerAccessPrompt(false)}
        onConfirm={() => runtime.answerAccessPrompt(true)}
      />
      <ToastHost toasts={rt.toasts} onDismiss={(id) => runtime.dismissToast(id)} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.lg },
  appOn: { display: 'flex', backgroundColor: color.bg },
  appOff: { display: 'none' },
});
