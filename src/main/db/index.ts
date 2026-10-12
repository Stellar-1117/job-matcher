import Database from 'better-sqlite3';
import { runMigrations } from './migrations';

let db: Database.Database | null = null;

export function openDb(file: string): Database.Database {
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  runMigrations(conn);
  db = conn;
  return conn;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised');
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export const bool = (v: unknown): boolean => v === 1 || v === true;
export const nowIso = (): string => new Date().toISOString();
