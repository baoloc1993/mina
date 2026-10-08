// S1 Đăng nhập: Email OTP (đường chính) + Google / Apple (phụ). Trạng thái: đang gửi · mã sai · provider chưa cấu hình · offline.
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { oauth, requestOtp, verifyOtp, type Provider } from '../auth/supabase';
import { validateCode, validateEmail, viAuthError } from '../auth/messages';
import { runtime, useRuntime } from '../runtime';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Body, Screen } from '../ui/Layout';
import { TextField } from '../ui/TextField';
import { Txt } from '../ui/Txt';
import { codeOf, errorFrom, errorText } from '../ui/errorText';
import { space } from '../ui/theme';
import { useBusy } from '../ui/useBusy';

const RESEND_SECONDS = 30;

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase();
  return m.includes('network') || m.includes('fetch failed') || m.includes('connectexception') || m.includes('timeout');
}

function verifyErrorText(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase();
  if (m.includes('expired') || m.includes('invalid')) return `${errorText('OTP_INVALID')}. Kiểm tra lại mã hoặc bấm "Gửi lại mã".`;
  return viAuthError(e, 'verify');
}

const HINT_TEXT = {
  expired: 'Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục — thay đổi chưa gửi vẫn được giữ.',
  revoked: 'Máy này đã bị đăng xuất từ thiết bị khác (SESSION_REVOKED). Đăng nhập lại để tiếp tục.',
} as const;

export function LoginScreen() {
  const rt = useRuntime();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [oauthErr, setOauthErr] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [choice, setChoice] = useState<{ pending: number } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sending, runSend] = useBusy();
  const [verifying, runVerify] = useBusy();
  const [resending, runResend] = useBusy();
  const [providerBusy, runProvider] = useBusy();
  const [providerName, setProviderName] = useState<Provider | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const noteNetwork = (e: unknown) => setOffline(isNetworkError(e));

  async function afterAuth() {
    const r = await runtime.completeSignIn();
    if (!r.ok) setChoice(r.needsChoice);
  }

  const send = () =>
    runSend(async () => {
      const bad = validateEmail(email);
      setEmailErr(bad);
      if (bad) return;
      try {
        await requestOtp(email.trim());
        setOffline(false);
        setStep('code');
        setCode('');
        setCodeErr(null);
        setCooldown(RESEND_SECONDS);
      } catch (e) {
        noteNetwork(e);
        setEmailErr(viAuthError(e, 'send'));
      }
    });

  const resend = () =>
    runResend(async () => {
      try {
        await requestOtp(email.trim());
        setOffline(false);
        setCodeErr(null);
        setCooldown(RESEND_SECONDS);
        runtime.pushToast({ kind: 'info', text: `Đã gửi lại mã tới ${email.trim()}` });
      } catch (e) {
        noteNetwork(e);
        setCodeErr(viAuthError(e, 'send'));
      }
    });

  const verify = () =>
    runVerify(async () => {
      const bad = validateCode(code);
      setCodeErr(bad);
      if (bad) return;
      try {
        await verifyOtp(email.trim(), code.trim());
        setOffline(false);
      } catch (e) {
        noteNetwork(e);
        setCodeErr(verifyErrorText(e));
        return;
      }
      try {
        await afterAuth();
      } catch (e) {
        setCodeErr(errorFrom(e));
      }
    });

  const social = (p: Provider) =>
    runProvider(async () => {
      setProviderName(p);
      setOauthErr(null);
      try {
        await oauth(p);
        setOffline(false);
        await afterAuth();
      } catch (e) {
        noteNetwork(e);
        setOauthErr(
          codeOf(e) === 'PROVIDER_UNAVAILABLE' ? errorText('PROVIDER_UNAVAILABLE', { provider: p === 'google' ? 'Google' : 'Apple' }) : errorFrom(e),
        );
      }
    });

  const resolve = async (c: 'switch' | 'stay') => {
    setResolving(true);
    try {
      await runtime.resolveAccountSwitch(c);
      if (c === 'stay') {
        setStep('email');
        setCode('');
      }
      setChoice(null);
    } catch (e) {
      runtime.pushToast({ kind: 'error', text: errorFrom(e) });
    } finally {
      setResolving(false);
    }
  };

  return (
    <Screen>
      <Body>
        <View style={styles.hero}>
          <Txt size="xl" weight="title" center accessibilityRole="header">
            Mina
          </Txt>
          <Txt tone="muted" center>
            Các app của riêng bạn
          </Txt>
        </View>

        {rt.loginHint ? <Banner tone="warning" text={HINT_TEXT[rt.loginHint]} /> : null}
        {offline ? <Banner tone="warning" text="Đang offline — cần mạng để đăng nhập" /> : null}

        {step === 'email' ? (
          <View style={styles.group}>
            <TextField
              label="Email"
              value={email}
              onChangeText={(v) => {
                setEmail(v);
                setEmailErr(null);
              }}
              error={emailErr}
              placeholder="ten@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              textContentType="emailAddress"
              returnKeyType="send"
              onSubmitEditing={() => void send()}
              disabled={sending}
              testID="login-email"
            />
            <Button title="Gửi mã" busy={sending} busyTitle="Đang gửi…" onPress={() => void send()} testID="login-send" />
          </View>
        ) : (
          <View style={styles.group}>
            <TextField
              label={`Mã 6 số đã gửi tới ${email.trim()}`}
              value={code}
              onChangeText={(v) => {
                setCode(v.replace(/\D/g, ''));
                setCodeErr(null);
              }}
              error={codeErr}
              placeholder="••••••"
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => void verify()}
              disabled={verifying}
              testID="login-code"
            />
            <Button title="Đăng nhập" busy={verifying} busyTitle="Đang kiểm tra…" onPress={() => void verify()} testID="login-verify" />
            <Button
              title={cooldown > 0 ? `Gửi lại mã (${cooldown}s)` : 'Gửi lại mã'}
              variant="ghost"
              compact
              busy={resending}
              busyTitle="Đang gửi…"
              disabled={cooldown > 0 || verifying}
              onPress={() => void resend()}
              style={styles.center}
            />
            <Button
              title="Đổi email"
              variant="ghost"
              compact
              disabled={verifying}
              onPress={() => {
                setStep('email');
                setCode('');
                setCodeErr(null);
              }}
              style={styles.center}
            />
          </View>
        )}

        <Txt tone="muted" center>
          hoặc
        </Txt>
        <View style={styles.group}>
          <Button
            title="Tiếp tục với Google"
            variant="secondary"
            busy={providerBusy && providerName === 'google'}
            busyTitle="Đang mở Google…"
            disabled={providerBusy || sending || verifying}
            onPress={() => void social('google')}
          />
          <Button
            title="Tiếp tục với Apple"
            variant="secondary"
            busy={providerBusy && providerName === 'apple'}
            busyTitle="Đang mở Apple…"
            disabled={providerBusy || sending || verifying}
            onPress={() => void social('apple')}
          />
          {oauthErr ? (
            <Txt size="sm" tone="danger" accessibilityLiveRegion="polite">
              {oauthErr}
            </Txt>
          ) : null}
        </View>
      </Body>

      <ConfirmDialog
        visible={!!choice}
        title="Còn thay đổi chưa gửi của tài khoản trước"
        message={`Máy này còn ${choice?.pending ?? 0} thay đổi chưa gửi của tài khoản trước. Đổi sang tài khoản này sẽ xoá chúng khỏi máy. Ở lại để đăng nhập lại tài khoản trước và gửi nốt.`}
        cancelLabel="Ở lại"
        confirmLabel="Vẫn đổi"
        busyLabel="Đang đổi…"
        danger
        busy={resolving}
        onCancel={() => void resolve('stay')}
        onConfirm={() => void resolve('switch')}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: space.xs, paddingTop: space.xl, paddingBottom: space.md },
  group: { gap: space.md },
  center: { alignSelf: 'center' },
});
