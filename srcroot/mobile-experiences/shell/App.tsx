// Shell vòng 1 (spike): đăng nhập Email OTP → mở DB mã hoá + sync → mở mini app hello trong WebView.
// Không phải UI sản phẩm (design system ở vòng 3): chỉ đủ để đi hết luồng lõi và đo.
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Platform, SafeAreaView, StatusBar as RNStatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { PowerSyncDatabase } from '@powersync/react-native';
import { requestOtp, supabase, tenantIdOf, verifyOtp } from './src/auth/supabase';
import { connectSync, disconnectAndClear, openDatabase } from './src/store/db';
import { installFromAsset, type InstalledApp } from './src/webview/packageManager';
import { MiniAppHost } from './src/webview/MiniAppHost';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const HELLO_ZIP = require('./assets/miniapp-hello.zip');

function syncLabel(db: PowerSyncDatabase | null): string {
  if (!db) return 'đang khởi động';
  const s = db.currentStatus;
  const up = s?.dataFlowStatus?.uploadError;
  if (up) return 'lỗi (thay đổi bị từ chối — đang giữ lại)';
  if (!s?.connected) return 'offline';
  if (s.dataFlowStatus?.uploading || s.dataFlowStatus?.downloading) return 'đang sync';
  return 'đã sync';
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export default function App() {
  const [db, setDb] = useState<PowerSyncDatabase | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [app, setApp] = useState<InstalledApp | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('đang khởi động');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState('');
  const [openTimes, setOpenTimes] = useState<number[]>([]);

  // Khởi động: mở DB mã hoá, cài hello, đọc session (có thể offline hoàn toàn).
  useEffect(() => {
    (async () => {
      const d = await openDatabase();
      setDb(d);
      setApp(await installFromAsset(HELLO_ZIP));
      const { data } = await supabase.auth.getSession();
      setSignedIn(!!data.session);
      setTenantId(data.session ? tenantIdOf(data.session.access_token) : null);
    })().catch((e) => setMsg(`Lỗi khởi động: ${e.message}`));
    const sub = supabase.auth.onAuthStateChange((_ev, session) => {
      setSignedIn(!!session);
      setTenantId(session ? tenantIdOf(session.access_token) : null);
    });
    return () => sub.data.subscription.unsubscribe();
  }, []);

  // Có session thì kết nối sync (offline vẫn mở được, engine tự thử lại).
  useEffect(() => {
    if (!db || !signedIn) return;
    connectSync(db).catch((e) => setMsg(`Sync: ${e.message}`));
    const off = db.registerListener({ statusChanged: () => setStatus(syncLabel(db)) });
    setStatus(syncLabel(db));
    return () => off();
  }, [db, signedIn]);

  const send = useCallback(async () => {
    try {
      await requestOtp(email.trim());
      setSent(true);
      setMsg('Đã gửi mã. Lấy mã ở hộp thư thử của Supabase local.');
    } catch (e) {
      setMsg(`Không gửi được mã: ${(e as Error).message}`);
    }
  }, [email]);

  const verify = useCallback(async () => {
    try {
      await verifyOtp(email.trim(), code.trim());
      setMsg('');
    } catch (e) {
      setMsg(`Mã sai hoặc hết hạn: ${(e as Error).message}`);
    }
  }, [email, code]);

  const logout = useCallback(async () => {
    setOpen(false);
    if (db) await disconnectAndClear(db);
    await supabase.auth.signOut();
  }, [db]);

  if (signedIn === null) {
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.pad}>{msg || 'Đang khởi động…'}</Text>
      </SafeAreaView>
    );
  }

  if (!signedIn) {
    return (
      <SafeAreaView style={[styles.root, styles.pad]}>
        <Text style={styles.h1}>Đăng nhập</Text>
        <TextInput
          style={styles.input}
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        {sent && (
          <TextInput style={styles.input} placeholder="Mã 6 số" keyboardType="number-pad" value={code} onChangeText={setCode} />
        )}
        <Button title={sent ? 'Xác nhận mã' : 'Gửi mã'} onPress={sent ? verify : send} />
        {!!msg && <Text style={styles.msg}>{msg}</Text>}
        <StatusBar style="auto" />
      </SafeAreaView>
    );
  }

  const med = median(openTimes);
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.bar}>
        <Text testID="sync-status" style={styles.status}>
          Trạng thái: {status}
        </Text>
        <Text style={styles.small}>
          tenant {tenantId ? tenantId.slice(0, 8) : '—'} · mở app: {openTimes.length} lần{med != null ? `, trung vị ${med} ms` : ''}
        </Text>
        <View style={styles.row}>
          {open ? (
            <Button title="Đóng app" onPress={() => setOpen(false)} />
          ) : (
            <Button title="Mở Hello" onPress={() => app && setOpen(true)} disabled={!app} />
          )}
          <Button title="Đăng xuất" onPress={logout} />
        </View>
        {!!msg && <Text style={styles.msg}>{msg}</Text>}
      </View>
      <View style={styles.fill}>
        {open && app && db ? (
          <MiniAppHost app={app} db={db} tenantId={tenantId} onOpenTimeMs={(ms) => setOpenTimes((p) => [...p, ms])} />
        ) : (
          <Text style={styles.pad}>Chưa mở mini app nào.</Text>
        )}
      </View>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#fff' },
  root: { flex: 1, backgroundColor: '#fff', paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 0 : 0 },
  pad: { padding: 16 },
  h1: { fontSize: 20, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#888', borderRadius: 6, padding: 10, marginBottom: 10, fontSize: 16 },
  bar: { padding: 12, borderBottomWidth: 1, borderColor: '#ddd' },
  status: { fontSize: 16, fontWeight: '600' },
  small: { fontSize: 12, color: '#444', marginVertical: 4 },
  row: { flexDirection: 'row', gap: 12 },
  msg: { marginTop: 8, color: '#a00' },
});
