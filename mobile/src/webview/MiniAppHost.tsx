// WebView Host (CAP-RT-01, AC-15/AC-14): nạp gói local, inject SDK 0.1.0 + CSP trước script app, chặn điều hướng ra ngoài,
// chuyển JSON-RPC sang bridge, đẩy sự kiện (suspend/resume/intent/sync) xuống app.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as FS from 'expo-file-system/legacy';
import { INJECTED_SDK } from '../../packages/miniapp-sdk/src/injected';
import { injectCsp } from '../../packages/miniapp-sdk/src/csp';
import { tokens } from '../../packages/miniapp-sdk/tokens/tokens';
import type { RpcRequest } from '../bridge/types';
import type { AppRuntimeInfo, RuntimeImpl } from '../runtime/runtime';

interface Props {
  appId: string;
  info: AppRuntimeInfo;
  visible: boolean;
  runtime: RuntimeImpl;
}

export function MiniAppHost({ appId, info, visible, runtime }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const web = useRef<WebView>(null);

  useEffect(() => {
    let alive = true;
    FS.readAsStringAsync(info.dir + info.row.manifest.entry).then((h) => alive && setHtml(injectCsp(h)));
    return () => {
      alive = false;
    };
  }, [info.dir, info.row.manifest.entry]);

  useEffect(() => {
    runtime.registerChannel(appId, {
      emit: (name, payload) => {
        const body = JSON.stringify(JSON.stringify(payload ?? {}));
        web.current?.injectJavaScript(`window.__miniappEvent && window.__miniappEvent(${JSON.stringify(name)}, ${body}); true;`);
      },
    });
    return () => runtime.registerChannel(appId, null);
  }, [appId, runtime]);

  // Sự kiện sync xuống app (sdk.on('sync')) mỗi khi trạng thái đổi.
  useEffect(() => {
    let last = '';
    return runtime.subscribe(() => {
      const s = runtime.getState().sync;
      const key = `${s.state}|${s.pending}|${s.rejected}`;
      if (key !== last && ready) {
        last = key;
        web.current?.injectJavaScript(`window.__miniappEvent && window.__miniappEvent("sync", ${JSON.stringify(JSON.stringify(s))}); true;`);
      }
    });
  }, [runtime, ready]);

  async function onMessage(e: WebViewMessageEvent) {
    let req: RpcRequest;
    try {
      req = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (req?.method === 'sdk.ready') setReady(true);
    const res = await info.rpc(req);
    web.current?.injectJavaScript(`window.__miniappResolve(${JSON.stringify(JSON.stringify(res))}); true;`);
  }

  const style = useMemo(() => (visible ? styles.fill : styles.hidden), [visible]);
  if (!html) return <View style={style}><ActivityIndicator style={styles.fill} color={tokens.color.primary} /></View>;
  return (
    <View style={style}>
      <WebView
        ref={web}
        style={styles.fill}
        originWhitelist={['file://*', 'about:*']}
        source={{ html, baseUrl: info.dir }}
        injectedJavaScriptBeforeContentLoaded={INJECTED_SDK}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(r) => r.url.startsWith('file://') || r.url.startsWith('about:')}
      />
      {!ready && visible && (
        <View style={styles.splash} pointerEvents="none">
          <ActivityIndicator color={tokens.color.primary} />
          <Text style={styles.splashText}>Đang mở {info.row.name}…</Text>
        </View>
      )}
    </View>
  );
}

const px = (v: string) => parseInt(v, 10);
const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { display: 'none' },
  splash: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.color.bg },
  splashText: { marginTop: px(tokens.space.sm), color: tokens.color['text-muted'], fontSize: px(tokens.text.base) },
});
