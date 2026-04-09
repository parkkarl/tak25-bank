import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'bank.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE,
    api_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    account_number TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(user_id),
    currency TEXT NOT NULL,
    balance TEXT NOT NULL DEFAULT '0.00',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bank_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transfers (
    transfer_id TEXT PRIMARY KEY,
    source_account TEXT NOT NULL,
    destination_account TEXT NOT NULL,
    amount TEXT NOT NULL,
    converted_amount TEXT,
    exchange_rate TEXT,
    rate_captured_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    pending_since TEXT,
    next_retry_at TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

export default db;
