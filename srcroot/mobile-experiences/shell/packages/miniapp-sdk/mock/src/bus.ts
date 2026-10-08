// Intent giữa hai tab mock qua BroadcastChannel('mina-mock-intents').
// Mỗi tab báo manifest của mình (announce); bảng receivers dựng từ các manifest đã báo. Tab nhận giao intent cho
// iframe của nó rồi trả ack — không ack kịp thì coi như `queued` (shell thật: xếp hàng platform_intents).
import type { IntentOutcome, Manifest } from '../../../../src/bridge/bridge';
import type { IntentBus, IntentMessage } from './host';

export const CHANNEL = 'mina-mock-intents';
export const ACK_TIMEOUT_MS = 1500;

type Msg =
  | { k: 'announce'; manifest: Manifest }
  | { k: 'who' }
  | { k: 'bye'; id: string }
  | { k: 'intent'; nonce: string; msg: IntentMessage }
  | { k: 'ack'; nonce: string; handled: boolean };

export interface TabBus extends IntentBus {
  /** Báo (lại) manifest của tab này — gọi khi nạp và khi người dùng đổi scope. */
  announce(manifest: Manifest): void;
  /** Đăng ký hàm nhận intent cho tab này; trả true nếu app đã xử lý. */
  onIntent(fn: (msg: IntentMessage) => boolean | Promise<boolean>): void;
  close(): void;
}

export function createTabBus(self: () => Manifest, name = CHANNEL): TabBus {
  const ch = new BroadcastChannel(name);
  const peers = new Map<string, Manifest>();
  const waiting = new Map<string, (handled: boolean) => void>();
  let handler: ((msg: IntentMessage) => boolean | Promise<boolean>) | null = null;
  const send = (m: Msg) => ch.postMessage(m);

  ch.onmessage = async (ev: MessageEvent<Msg>) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.k === 'announce') peers.set(m.manifest.id, m.manifest);
    else if (m.k === 'bye') peers.delete(m.id);
    else if (m.k === 'who') send({ k: 'announce', manifest: self() });
    else if (m.k === 'intent') {
      if (m.msg.to !== self().id || !handler) return;
      let handled = false;
      try {
        handled = await handler(m.msg);
      } catch {
        handled = false;
      }
      send({ k: 'ack', nonce: m.nonce, handled });
    } else if (m.k === 'ack') {
      waiting.get(m.nonce)?.(m.handled);
    }
  };
  send({ k: 'who' });

  const bus: TabBus = {
    peers: () => {
      const all = new Map(peers);
      all.set(self().id, self()); // tab này luôn là một receiver của chính nó (bridge tự loại khi gửi cho chính mình)
      return [...all.values()];
    },
    announce: (manifest) => {
      peers.set(manifest.id, manifest);
      send({ k: 'announce', manifest });
    },
    onIntent: (fn) => {
      handler = fn;
    },
    deliver: (msg) =>
      new Promise<IntentOutcome>((resolve) => {
        const nonce = globalThis.crypto.randomUUID();
        const finish = (out: IntentOutcome) => {
          clearTimeout(timer);
          waiting.delete(nonce);
          resolve(out);
        };
        const timer = setTimeout(() => finish('queued'), ACK_TIMEOUT_MS);
        waiting.set(nonce, (handled) => finish(handled ? (msg.mode === 'open' ? 'opened' : 'handled') : 'queued'));
        send({ k: 'intent', nonce, msg });
      }),
    close: () => {
      send({ k: 'bye', id: self().id });
      ch.close();
    },
  };
  return bus;
}
