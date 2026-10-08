// WebView Host (CAP-RT-01): nạp gói local, inject SDK trước script app, CSP do shell chèn,
// chặn điều hướng ra ngoài, log thời gian từ lúc bấm mở tới sdk.ready.
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { PowerSyncDatabase } from '@powersync/react-native';
import { handleRpc, tablePrefix, type RpcRequest } from '../bridge/bridge';
import { getAppToken } from '../auth/supabase';
import { INJECTED_SDK, injectCsp } from './injectedSdk';
import { readEntryHtml, type InstalledApp } from './packageManager';

interface Props {
  app: InstalledApp;
  db: PowerSyncDatabase;
  tenantId: string | null;
  onOpenTimeMs(ms: number): void;
}

export function MiniAppHost({ app, db, tenantId, onOpenTimeMs }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const web = useRef<WebView>(null);
  const t0 = useRef(Date.now());

  useEffect(() => {
    t0.current = Date.now();
    readEntryHtml(app).then((h) => setHtml(injectCsp(h)));
  }, [app]);

  async function onMessage(e: WebViewMessageEvent) {
    let req: RpcRequest;
    try {
      req = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    const res = await handleRpc(req, {
      manifest: app.manifest,
      getTenantId: () => tenantId,
      now: () => new Date().toISOString(),
      dbGetAll: (sql, params) => db.getAll(sql, params as unknown[]),
      dbExecute: async (sql, params) => {
        await db.execute(sql, params as unknown[]);
      },
      getAppToken,
      onReady: () => {
        const ms = Date.now() - t0.current;
        console.log(`[miniapp] ${app.manifest.id} ready sau ${ms} ms`);
        onOpenTimeMs(ms);
        setReady(true);
      },
    });
    web.current?.injectJavaScript(`window.__miniappResolve(${JSON.stringify(JSON.stringify(res))}); true;`);
  }

  if (!html) return <ActivityIndicator style={styles.fill} />;
  return (
    <View style={styles.fill}>
      <WebView
        ref={web}
        style={styles.fill}
        originWhitelist={['file://*', 'about:*']}
        source={{ html, baseUrl: app.dir }}
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
      {!ready && (
        <View style={styles.splash} pointerEvents="none">
          <ActivityIndicator />
          <Text>{app.manifest.name}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  splash: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
});

export { tablePrefix };
