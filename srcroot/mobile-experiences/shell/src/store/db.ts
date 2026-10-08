// Local store (CAP-SYNC-01/02/06): PowerSync trên SQLite + SQLCipher. Một file DB cho mọi app.
import { PowerSyncDatabase, Schema, Table, column } from '@powersync/react-native';
import { getOrCreateDbKey } from './secureKey';
import { Connector } from './connector';

// Vòng 1: chỉ bảng của fixture vn.app.hello. `id` do PowerSync tự thêm (text, UUID client sinh).
const app_hello_items = new Table(
  {
    tenant_id: column.text,
    title: column.text,
    done: column.integer,
    created_at: column.text,
    updated_at: column.text,
    deleted_at: column.text,
  },
  { indexes: {} },
);

export const AppSchema = new Schema({ app_hello_items });

let db: PowerSyncDatabase | null = null;

export async function openDatabase(): Promise<PowerSyncDatabase> {
  if (db) return db;
  const encryptionKey = await getOrCreateDbKey();
  db = new PowerSyncDatabase({
    schema: AppSchema,
    database: { dbFilename: 'platform.db', sqliteOptions: { encryptionKey } },
  });
  await db.init();
  return db;
}

export async function connectSync(database: PowerSyncDatabase): Promise<void> {
  await database.connect(new Connector());
}

export async function disconnectAndClear(database: PowerSyncDatabase): Promise<void> {
  await database.disconnectAndClear();
}
