import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { join } from 'node:path';

export async function runMigrations(): Promise<void> {
  const client = postgres(process.env['DATABASE_URL']!);
  const db = drizzle(client);

  // Migrations are copied to /app/src/server/db/migrations in the container (WORKDIR /app)
  const migrationsFolder = join(process.cwd(), 'src/server/db/migrations');

  console.log('[migrate] Applying pending migrations...');
  await migrate(db, { migrationsFolder });
  await client.end();
  console.log('[migrate] Done');
}
