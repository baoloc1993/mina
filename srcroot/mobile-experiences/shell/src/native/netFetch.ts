// sdk.net.fetch (CAP-RT-06, AC-8): MỌI request đi từ native fetch của shell (WebView vẫn connect-src 'none').
// Chuyển hướng đi từng bước bằng `redirect: 'manual'` (expo/fetch → OkHttp followRedirects(false)); mỗi đích mới phải qua
// `isAllowed` TRƯỚC khi gửi ⇒ redirect sang domain lạ ⇒ NET_BLOCKED và không có request nào rời máy tới domain đó.
import { fetch as expoFetch } from 'expo/fetch';
import { BridgeError } from '../bridge/types';

const MAX_HOPS = 5;
const MAX_BODY = 5 * 1024 * 1024;

export async function nativeNetFetch(
  req: { url: string; method: string; headers: Record<string, string>; body: string | null; timeoutMs: number },
  isAllowed: (url: string) => boolean,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let url = req.url;
  let method = req.method;
  let body = req.body;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!isAllowed(url)) throw new BridgeError('NET_BLOCKED', 'Chuyển hướng tới domain không được phép', new URL(url).hostname);
      let res;
      try {
        res = await expoFetch(url, { method, headers: req.headers, body: method === 'GET' || method === 'HEAD' ? undefined : (body ?? undefined), redirect: 'manual', signal: ctl.signal });
      } catch (e) {
        if (e instanceof BridgeError) throw e;
        const aborted = ctl.signal.aborted;
        throw new BridgeError(aborted ? 'NET_ERROR' : 'OFFLINE', aborted ? 'Hết thời gian chờ' : 'Không có mạng');
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location') as string, url).toString();
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = null;
        }
        continue;
      }
      const text = await res.text();
      if (text.length > MAX_BODY) throw new BridgeError('NET_ERROR', 'Phản hồi quá 5 MB');
      const headers: Record<string, string> = {};
      res.headers.forEach((v: string, k: string) => {
        headers[k] = v;
      });
      return { status: res.status, headers, body: text };
    }
    throw new BridgeError('NET_ERROR', 'Quá nhiều lần chuyển hướng');
  } finally {
    clearTimeout(timer);
  }
}
