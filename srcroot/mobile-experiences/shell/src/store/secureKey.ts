// Khoá SQLCipher (CAP-SYNC-06, AC-4): 32 byte ngẫu nhiên sinh lần đầu, lưu trong Android Keystore
// (expo-secure-store). Không bao giờ log, không ghi ra file cấu hình.
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const KEY_NAME = 'sqlcipher_key_v1';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getOrCreateDbKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY_NAME);
  if (existing) return existing;
  const key = toHex(Crypto.getRandomBytes(32));
  await SecureStore.setItemAsync(KEY_NAME, key, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  return key;
}

/** Bộ lưu session cho supabase-js trên SecureStore. Value >2KB nên cắt thành mảnh. */
const CHUNK = 1800;
export const secureSessionStorage = {
  async getItem(name: string): Promise<string | null> {
    const n = await SecureStore.getItemAsync(`${name}.n`);
    if (!n) return null;
    let out = '';
    for (let i = 0; i < Number(n); i++) {
      const part = await SecureStore.getItemAsync(`${name}.${i}`);
      if (part == null) return null;
      out += part;
    }
    return out;
  },
  async setItem(name: string, value: string): Promise<void> {
    const parts = value.match(new RegExp(`.{1,${CHUNK}}`, 'gs')) ?? [''];
    for (let i = 0; i < parts.length; i++) {
      await SecureStore.setItemAsync(`${name}.${i}`, parts[i], { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
    }
    await SecureStore.setItemAsync(`${name}.n`, String(parts.length));
  },
  async removeItem(name: string): Promise<void> {
    const n = Number(await SecureStore.getItemAsync(`${name}.n`));
    for (let i = 0; i < n; i++) await SecureStore.deleteItemAsync(`${name}.${i}`);
    await SecureStore.deleteItemAsync(`${name}.n`);
  },
};
