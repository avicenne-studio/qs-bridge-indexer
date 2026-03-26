import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

// Ensure data directory exists
mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS qsb_events (
    hash        TEXT PRIMARY KEY,
    tick        INTEGER NOT NULL,
    type        TEXT NOT NULL,
    source      TEXT NOT NULL,
    to_address  TEXT NOT NULL,
    amount      TEXT NOT NULL,
    relayer_fee TEXT NOT NULL,
    nonce       TEXT NOT NULL,
    network_out INTEGER NOT NULL,
    order_era   TEXT NOT NULL DEFAULT '0',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_qsb_nonce ON qsb_events(nonce);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export const stmts = {
  getMeta: db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),

  insertEvent: db.prepare(`
    INSERT OR IGNORE INTO qsb_events (hash, tick, type, source, to_address, amount, relayer_fee, nonce, network_out, order_era)
    VALUES (@hash, @tick, @type, @source, @toAddress, @amount, @relayerFee, @nonce, @networkOut, @orderEra)
  `),

  updateOrderEra: db.prepare(`
    UPDATE qsb_events SET order_era = ? WHERE hash = ? AND order_era = '0'
  `),

  getAllEvents: db.prepare('SELECT * FROM qsb_events ORDER BY tick ASC'),

  getEventByHash: db.prepare<[string], QsbEventRow>('SELECT * FROM qsb_events WHERE hash = ?'),

  getPendingOrderEras: db.prepare<[], { hash: string; nonce: string }>(
    "SELECT hash, nonce FROM qsb_events WHERE order_era = '0'"
  ),
};

export interface QsbEventRow {
  hash:        string;
  tick:        number;
  type:        string;
  source:      string;
  to_address:  string;
  amount:      string;
  relayer_fee: string;
  nonce:       string;
  network_out: number;
  order_era:   string;
  created_at:  string;
}

export function getLastIndexedTick(): number {
  const row = stmts.getMeta.get('last_tick');
  return row ? parseInt(row.value) : 0;
}

export function setLastIndexedTick(tick: number): void {
  stmts.setMeta.run('last_tick', String(tick));
}
