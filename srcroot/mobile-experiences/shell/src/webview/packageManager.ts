// Package Manager (vòng 1, tối thiểu): giải nén gói zip của mini app vào <docs>/apps/<app_id>/<version>/.
// Chưa có registry, chữ ký, SHA-256 (vòng 2–3) — vòng 1 gói đi kèm shell như asset.
import * as FS from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import { unzipSync } from 'fflate';
import type { Manifest } from '../bridge/bridge';

export interface InstalledApp {
  manifest: Manifest;
  dir: string; // file:///.../apps/<id>/<version>/
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Chỉ cho phép đường dẫn tương đối nằm trong thư mục version (chống zip-slip). */
function safeRel(p: string): string | null {
  if (p.startsWith('/') || p.includes('..') || p.includes('\\')) return null;
  return p;
}

export async function installFromAsset(moduleId: number): Promise<InstalledApp> {
  const asset = Asset.fromModule(moduleId);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('Không đọc được gói zip');
  const zipB64 = await FS.readAsStringAsync(asset.localUri, { encoding: FS.EncodingType.Base64 });
  const files = unzipSync(b64ToBytes(zipB64));
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes) throw new Error('Gói thiếu manifest.json');
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  const dir = `${FS.documentDirectory}apps/${manifest.id}/${manifest.version}/`;
  await FS.makeDirectoryAsync(dir, { intermediates: true });
  for (const [name, data] of Object.entries(files)) {
    const rel = safeRel(name);
    if (!rel) throw new Error(`Đường dẫn không an toàn trong gói: ${name}`);
    if (name.endsWith('/')) {
      await FS.makeDirectoryAsync(dir + rel, { intermediates: true });
      continue;
    }
    const slash = rel.lastIndexOf('/');
    if (slash > 0) await FS.makeDirectoryAsync(dir + rel.slice(0, slash), { intermediates: true });
    await FS.writeAsStringAsync(dir + rel, bytesToB64(data), { encoding: FS.EncodingType.Base64 });
  }
  return { manifest, dir };
}

export async function readEntryHtml(app: InstalledApp): Promise<string> {
  return FS.readAsStringAsync(app.dir + app.manifest.entry);
}
