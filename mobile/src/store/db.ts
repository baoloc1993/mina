// Local store (CAP-SYNC-01/02/06): PowerSync trên SQLite + SQLCipher. Một file DB cho mọi app.
// Schema động: bảng nền + bảng của app đã cài (suy ra từ migration) + `platform_*` cục bộ.
import { PowerSyncDatabase } from '@powersync/react-native';
import { getOrCreateDbKey } from './secureKey';
import { PowerSyncAppRepo } from './repo';
import { buildSchema } from './schema';

let db: PowerSyncDatabase | null = null;

export async function openDatabase(): Promise<PowerSyncDatabase> {
  if (db) return db;
  const encryptionKey = await getOrCreateDbKey();
  const d = new PowerSyncDatabase({
    schema: buildSchema([]),
    database: { dbFilename: 'platform.db', sqliteOptions: { encryptionKey } },
  });
  await d.init();
  const apps = await new PowerSyncAppRepo(d).list();
  if (apps.length) await d.updateSchema(buildSchema(apps));
  db = d;
  return d;
}

/** Dựng lại schema từ các app đang cài (gọi sau cài / cập nhật / gỡ). */
export async function rebuildSchema(database: PowerSyncDatabase): Promise<void> {
  await database.updateSchema(buildSchema(await new PowerSyncAppRepo(database).list()));
}

export async function disconnectAndClear(database: PowerSyncDatabase): Promise<void> {
  await database.disconnectAndClear();
}
