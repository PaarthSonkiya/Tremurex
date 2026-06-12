import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from './client.js';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
