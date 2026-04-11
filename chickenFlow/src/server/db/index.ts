import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { join } from 'node:path';
import * as schema from './schema.js';

const dbPath = process.env['DB_PATH'] ?? join(process.cwd(), 'chickenflow.db');

const sqlite = new Database(dbPath);

// WAL mode: concurrent reads during writes — critical for API + job scheduler on same event loop.
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
