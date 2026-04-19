import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const client = postgres(process.env['DATABASE_URL']!);

export const pgClient = client;
export const db = drizzle(client, { schema });
export type DB = typeof db;
