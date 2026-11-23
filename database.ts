import { createClient } from '@libsql/client/web';
import type { InValue, TransactionMode } from '@libsql/client/web';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';

type Statement = string | { sql: string; args?: Extract<InValue, SQLInputValue>[] };
type QueryResult<Row = Record<string, unknown>> = { rows: Row[] };
type TableColumn = { name: string };

export interface Database {
  execute(statement: Statement): Promise<QueryResult>;
  batch(statements: Statement[], mode?: TransactionMode): Promise<QueryResult[]>;
  close(): void;
  fingerprintKey: string;
}

interface DatabaseOptions {
  dbPath?: string;
  databaseUrl?: string;
  authToken?: string;
}

export async function openDatabase({
  dbPath = join(process.cwd(), 'data/cards.sqlite'),
  databaseUrl = process.env.DATABASE_URL,
  authToken = process.env.DATABASE_AUTH_TOKEN,
}: DatabaseOptions = {}): Promise<Database> {
  let db: Omit<Database, 'fingerprintKey'> & Partial<Pick<Database, 'fingerprintKey'>>;
  if (databaseUrl) {
    db = createClient({ url: databaseUrl, authToken });
  } else {
    if (process.env.VERCEL) throw new Error('set DATABASE_URL and DATABASE_AUTH_TOKEN in vercel.');
    const { DatabaseSync } = await import('node:sqlite');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec('PRAGMA journal_mode = WAL');
    const execute = (statement: Statement) => {
      const { sql, args = [] } = typeof statement === 'string' ? { sql: statement } : statement;
      return { rows: sqlite.prepare(sql).all(...args) };
    };
    db = {
      execute: async (statement) => execute(statement),
      batch: async (statements) => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const results = statements.map(execute);
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
      close: () => sqlite.close(),
    };
  }
  await db.batch(
    [
      'CREATE TABLE IF NOT EXISTS accounts (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS cards (slug TEXT PRIMARY KEY, owner TEXT NOT NULL, card TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS cards_owner ON cards(owner)',
      'CREATE TABLE IF NOT EXISTS abuse_reports (id INTEGER PRIMARY KEY, slug TEXT NOT NULL, url TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER)',
      'CREATE INDEX IF NOT EXISTS abuse_reports_pending ON abuse_reports(resolved_at, created_at)',
      'CREATE TABLE IF NOT EXISTS creator_fingerprints (fingerprint TEXT PRIMARY KEY, created_at INTEGER NOT NULL, banned_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS owner_fingerprints (owner TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner, fingerprint))',
      'CREATE INDEX IF NOT EXISTS owner_fingerprints_fingerprint ON owner_fingerprints(fingerprint)',
      'CREATE TABLE IF NOT EXISTS banned_slugs (slug TEXT PRIMARY KEY, banned_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS fingerprint_signatures (fingerprint TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY (fingerprint, signature))',
      'CREATE INDEX IF NOT EXISTS fingerprint_signatures_signature ON fingerprint_signatures(signature)',
      'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      {
        sql: "INSERT INTO app_settings (key, value) VALUES ('fingerprint_key', ?) ON CONFLICT(key) DO NOTHING",
        args: [randomBytes(32).toString('hex')],
      },
      'CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
    ],
    'write',
  );
  for (const [table, column, type] of [
    ['abuse_reports', 'reporter_fingerprint', 'TEXT'],
    ['abuse_reports', 'reason', 'TEXT'],
    ['abuse_reports', 'details', 'TEXT'],
    ['creator_fingerprints', 'reporting_banned_at', 'INTEGER'],
    ['cards', 'sponsored_at', 'INTEGER'],
    ['cards', 'verified_at', 'INTEGER'],
    ['cards', 'custom_badges', 'TEXT'],
  ]) {
    // PRAGMA table_info always returns a name column.
    const columns = (await db.execute(
      'PRAGMA table_info(' + table + ')',
    )) as QueryResult<TableColumn>;
    if (!columns.rows.some((item) => item.name === column)) {
      try {
        await db.execute('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type);
      } catch (error) {
        // Both drivers report SQL failures as Error objects.
        if (!/duplicate column/i.test((error as Error).message)) throw error;
      }
    }
  }
  // The startup batch inserts the key into the app_settings TEXT column.
  db.fingerprintKey = (
    (await db.execute(
      "SELECT value FROM app_settings WHERE key = 'fingerprint_key'",
    )) as QueryResult<{ value: string }>
  ).rows[0].value;
  // PRAGMA table_info always returns a name column.
  const cardColumns = (await db.execute('PRAGMA table_info(cards)')) as QueryResult<TableColumn>;
  if (!cardColumns.rows.some((column) => column.name === 'creator_fingerprint')) {
    try {
      await db.execute('ALTER TABLE cards ADD COLUMN creator_fingerprint TEXT');
    } catch (error) {
      // Both drivers report SQL failures as Error objects.
      if (!/duplicate column/i.test((error as Error).message)) throw error;
    }
  }
  // PRAGMA table_info always returns a name column.
  const accountColumns = (await db.execute(
    'PRAGMA table_info(accounts)',
  )) as QueryResult<TableColumn>;
  if (!accountColumns.rows.some((column) => column.name === 'revoked_at')) {
    try {
      await db.execute('ALTER TABLE accounts ADD COLUMN revoked_at INTEGER');
    } catch (error) {
      // Both drivers report SQL failures as Error objects.
      if (!/duplicate column/i.test((error as Error).message)) throw error;
    }
  }
  // PRAGMA table_info always returns a name column.
  const columns = (await db.execute('PRAGMA table_info(cards)')) as QueryResult<TableColumn>;
  if (columns.rows.some((column) => column.name === 'expires_at')) {
    try {
      await db.execute('ALTER TABLE cards DROP COLUMN expires_at');
    } catch (error) {
      // Both drivers report SQL failures as Error objects.
      if (!/no such column/i.test((error as Error).message)) throw error;
    }
  }
  // The key is assigned above before the client can leave initialization.
  return db as Database;
}
