// Shell vòng 1 (spike): đăng nhập Email OTP → mở DB mã hoá + sync → mở mini app hello trong WebView.
// Không phải UI sản phẩm (design system ở vòng 3): chỉ đủ để đi hết luồng lõi và đo.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  LogBox,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { PowerSyncDatabase } from '@powersync/react-native';
import { config } from './src/config';
import { requestOtp, supabase, tenantIdOf, verifyOtp } from './src/auth/supabase';
import { validateCode, validateEmail, viAuthError } from './src/auth/messages';
import { connectSync, disconnectAndClear, openDatabase } from './src/store/db';
import { installFromAsset, type InstalledApp } from './src/webview/packageManager';
import { MiniAppHost } from './src/webview/MiniAppHost';

// Mất mạng là trạng thái bình thường của app offline-first: PowerSync log nó bằng console.error,
// LogBox ở bản dev biến nó thành màn đỏ chặn thao tác. Chỉ ẩn log sync, lỗi khác vẫn hiện.
LogBox.ignoreLogs(['[PowerSync]']);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const HELLO_ZIP = require('./assets/miniapp-hello.zip');

type Tone = 'ok' | 'busy' | 'warn' | 'err';

/** Nhãn đúng 4 dạng của PRD §7 (+ số thay đổi đang chờ). Mất mạng KHÔNG phải "bị từ chối". */
function syncLabel(db: PowerSyncDatabase | null, pending: number): { text: string; tone: Tone } {
  if (!db) return { text: 'đang khởi động', tone: 'busy' };
  const s = db.currentStatus;
  const wait = pending > 0 ? ` — ${pending} thay đổi chờ đồng bộ` : '';
  if (!s?.connected) return { text: `offline${wait}`, tone: 'warn' };
  const upErr = s.dataFlowStatus?.uploadError as Error | undefined;
  if (upErr && /bị từ chối/.test(upErr.message ?? '')) {
    return { text: `lỗi (${pending || 1} thay đổi bị từ chối — đang giữ lại)`, tone: 'err' };
  }
  if (upErr || s.dataFlowStatus?.uploading || s.dataFlowStatus?.downloading || pending > 0) {
    return { text: `đang sync${wait}`, tone: 'busy' };
  }
  return { text: 'đã sync', tone: 'ok' };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function Btn(props: { title: string; onPress(): void; disabled?: boolean; secondary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.btn,
        props.secondary && styles.btnSecondary,
        props.disabled && styles.btnDisabled,
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text style={[styles.btnText, props.secondary && styles.btnTextSecondary]}>{props.title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [db, setDb] = useState<PowerSyncDatabase | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [app, setApp] = useState<InstalledApp | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: Tone }>({ text: 'đang khởi động', tone: 'busy' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [info, setInfo] = useState('');
  const [err, setErr] = useState('');
  const [openTimes, setOpenTimes] = useState<number[]>([]);
  const [rows, setRows] = useState<number | null>(null);
  const [pending, setPending] = useState(0);

  // Khởi động: mở DB mã hoá, cài hello, đọc session (có thể offline hoàn toàn).
  useEffect(() => {
    (async () => {
      const d = await openDatabase();
      setDb(d);
      setApp(await installFromAsset(HELLO_ZIP));
      const { data } = await supabase.auth.getSession();
      setSignedIn(!!data.session);
      setTenantId(data.session ? tenantIdOf(data.session.access_token) : null);
    })().catch((e) => setErr('Không khởi động được ứng dụng. Thử mở lại.' + (__DEV__ ? ` (${e.message})` : '')));
    const sub = supabase.auth.onAuthStateChange((_ev, session) => {
      setSignedIn(!!session);
      setTenantId(session ? tenantIdOf(session.access_token) : null);
    });
    return () => sub.data.subscription.unsubscribe();
  }, []);

  // Có session thì kết nối sync (offline vẫn mở được, engine tự thử lại).
  useEffect(() => {
    if (!db || !signedIn) return;
    connectSync(db).catch(() => undefined);
    const off = db.registerListener({ statusChanged: () => setStatus(syncLabel(db, pending)) });
    setStatus(syncLabel(db, pending));
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, signedIn]);

  // Bộ canh kết nối: sau khi mạng quay lại, kết nối PowerSync đôi khi treo ~40 s mới tự thử lại
  // (đo ở dogfood AC-2). Khi server đã tới được mà trạng thái vẫn offline thì nối lại ngay.
  // Bản production nên dùng NetInfo (module native) — xem DECISIONS.
  useEffect(() => {
    if (!db || !signedIn) return;
    let busy = false;
    const t = setInterval(async () => {
      if (busy || db.currentStatus?.connected) return;
      busy = true;
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 2000);
        const r = await fetch(`${config.powersyncUrl}/probes/liveness`, { signal: ctl.signal });
        clearTimeout(to);
        if (r.ok && !db.currentStatus?.connected) {
          await db.disconnect();
          await connectSync(db);
        }
      } catch {
        // vẫn offline thật — thử lại ở nhịp sau
      } finally {
        busy = false;
      }
    }, 2000);
    return () => clearInterval(t);
  }, [db, signedIn]);

  // Số dòng local + số thay đổi chờ đồng bộ (không đi qua bridge).
  useEffect(() => {
    if (!db || !signedIn) return;
    const t = setInterval(async () => {
      try {
        const r = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM app_hello_items WHERE deleted_at IS NULL');
        setRows(r.n);
        const q = await db.getUploadQueueStats();
        setPending(q.count);
        setStatus(syncLabel(db, q.count));
      } catch {
        // DB đang bận — nhịp sau
      }
    }, 1000);
    return () => clearInterval(t);
  }, [db, signedIn]);

  const send = useCallback(async () => {
    setInfo('');
    const bad = validateEmail(email);
    if (bad) {
      setErr(bad);
      return;
    }
    try {
      await requestOtp(email.trim());
      setSent(true);
      setErr('');
      setInfo(`Đã gửi mã 6 số tới ${email.trim()}. Mở hộp thư để lấy mã.`);
    } catch (e) {
      setErr(viAuthError(e, 'send'));
    }
  }, [email]);

  const verify = useCallback(async () => {
    const bad = validateCode(code);
    if (bad) {
      setErr(bad);
      return;
    }
    try {
      await verifyOtp(email.trim(), code.trim());
      setErr('');
      setInfo('');
    } catch (e) {
      setErr(viAuthError(e, 'verify'));
    }
  }, [email, code]);

  const changeEmail = useCallback(() => {
    setSent(false);
    setCode('');
    setErr('');
    setInfo('');
  }, []);

  const doLogout = useCallback(async () => {
    setOpen(false);
    if (db) await disconnectAndClear(db);
    await supabase.auth.signOut();
    setEmail('');
    setCode('');
    setSent(false);
    setInfo('');
    setErr('');
  }, [db]);

  // Đăng xuất xoá dữ liệu trên máy: nếu còn thay đổi chưa gửi lên server thì phải báo trước (dogfood: mất dữ liệu).
  const logout = useCallback(async () => {
    let n = 0;
    try {
      n = db ? (await db.getUploadQueueStats()).count : 0;
    } catch {
      n = 0;
    }
    if (n === 0) {
      await doLogout();
      return;
    }
    Alert.alert(
      'Còn thay đổi chưa đồng bộ',
      `Còn ${n} thay đổi chưa gửi lên máy chủ. Đăng xuất bây giờ sẽ làm mất chúng. Nên bật mạng và chờ "đã sync" trước.`,
      [
        { text: 'Ở lại', style: 'cancel' },
        { text: 'Vẫn đăng xuất', style: 'destructive', onPress: () => void doLogout() },
      ],
    );
  }, [db, doLogout]);

  if (signedIn === null) {
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.pad}>{err || 'Đang khởi động…'}</Text>
      </SafeAreaView>
    );
  }

  if (!signedIn) {
    return (
      <SafeAreaView style={[styles.root, styles.pad]}>
        <Text style={styles.h1}>Đăng nhập</Text>
        <TextInput
          style={[styles.input, sent && styles.inputLocked]}
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          editable={!sent}
          value={email}
          onChangeText={setEmail}
        />
        {sent && (
          <TextInput
            style={styles.input}
            placeholder="Mã 6 số"
            keyboardType="number-pad"
            maxLength={6}
            value={code}
            onChangeText={setCode}
          />
        )}
        <Btn title={sent ? 'Xác nhận mã' : 'Gửi mã'} onPress={sent ? verify : send} />
        {sent && (
          <View style={styles.rowTight}>
            <Btn secondary title="Gửi lại mã" onPress={send} />
            <Btn secondary title="Đổi email" onPress={changeEmail} />
          </View>
        )}
        {!!info && <Text style={styles.info}>{info}</Text>}
        {!!err && <Text style={styles.msg}>{err}</Text>}
        <StatusBar style="auto" />
      </SafeAreaView>
    );
  }

  const med = median(openTimes);
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.bar}>
        <Text testID="sync-status" style={[styles.status, toneStyle[status.tone]]}>
          Trạng thái: {status.text}
        </Text>
        <Text style={styles.small}>
          tenant {tenantId ? tenantId.slice(0, 8) : '—'} · mục local: {rows ?? '—'}
        </Text>
        <Text style={styles.small}>
          mở app: {openTimes.length} lần{med != null ? ` · trung vị ${med} ms` : ''}
        </Text>
        <View style={styles.row}>
          {open ? <Btn title="Đóng app" onPress={() => setOpen(false)} /> : <Btn title="Mở Hello" onPress={() => app && setOpen(true)} disabled={!app} />}
          <View style={styles.spacer} />
          <Btn secondary title="Đăng xuất" onPress={logout} />
        </View>
        {!!err && <Text style={styles.msg}>{err}</Text>}
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

// Màu chữ đều đạt tương phản ≥ 4.5:1 trên nền trắng (đo ở dogfood: nút xanh cũ #2196F3 chỉ 3.12:1).
const BLUE = '#1565C0';
const toneStyle = StyleSheet.create({
  ok: { color: '#166534' },
  busy: { color: BLUE },
  warn: { color: '#92400E' },
  err: { color: '#B00020' },
});

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#fff' },
  root: { flex: 1, backgroundColor: '#fff', paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 0 : 0 },
  pad: { padding: 16 },
  h1: { fontSize: 20, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#767676', borderRadius: 6, padding: 12, marginBottom: 12, fontSize: 16, minHeight: 48 },
  inputLocked: { backgroundColor: '#F3F4F6', color: '#374151' },
  bar: { padding: 12, borderBottomWidth: 1, borderColor: '#ddd' },
  status: { fontSize: 18, fontWeight: '700' },
  small: { fontSize: 14, color: '#374151', marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  rowTight: { flexDirection: 'row', gap: 12, marginTop: 12 },
  spacer: { flex: 1, minWidth: 24 },
  msg: { marginTop: 10, color: '#B00020', fontSize: 15 },
  info: { marginTop: 10, color: '#166534', fontSize: 15 },
  btn: { backgroundColor: BLUE, borderRadius: 6, minHeight: 48, minWidth: 96, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  btnSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: BLUE },
  btnDisabled: { backgroundColor: '#6B7280' },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  btnTextSecondary: { color: BLUE },
});
