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

// Idempotent migrations — ALTER TABLE throws if column exists; that is intentional
try { db.exec(`ALTER TABLE qsb_events ADD COLUMN order_hash TEXT`);  } catch { /* already exists */ }
try { db.exec(`ALTER TABLE qsb_events ADD COLUMN success    TEXT`);  } catch { /* already exists */ }

export const stmts = {
  getMeta: db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),

  // Lock events (existing — unchanged)
  insertEvent: db.prepare(`
    INSERT OR IGNORE INTO qsb_events (hash, tick, type, source, to_address, amount, relayer_fee, nonce, network_out, order_era)
    VALUES (@hash, @tick, @type, @source, @toAddress, @amount, @relayerFee, @nonce, @networkOut, @orderEra)
  `),

  updateOrderEra: db.prepare(`
    UPDATE qsb_events SET order_era = ? WHERE hash = ? AND order_era = '0'
  `),

  getPendingOrderEras: db.prepare<[], { hash: string; nonce: string }>(
    "SELECT hash, nonce FROM qsb_events WHERE type != 'unlock' AND order_era = '0'"
  ),

  // Unlock events
  insertUnlockEvent: db.prepare(`
    INSERT OR IGNORE INTO qsb_events
      (hash, tick, type, source, to_address, amount, relayer_fee, nonce, network_out, order_era, order_hash)
    VALUES
      (@hash, @tick, @type, @source, @toAddress, @amount, @relayerFee, @nonce, @networkOut, @orderEra, @orderHash)
  `),

  updateUnlockSuccess: db.prepare(
    `UPDATE qsb_events SET success = ? WHERE hash = ? AND type = 'unlock' AND success IS NULL`
  ),

  getPendingUnlocks: db.prepare<[], { hash: string; tick: number; order_hash: string }>(
    `SELECT hash, tick, order_hash FROM qsb_events WHERE type = 'unlock' AND success IS NULL AND order_hash IS NOT NULL`
  ),

  // GET /events — unlock rows only appear once success='1'
  getAllEvents: db.prepare(
    `SELECT * FROM qsb_events
     WHERE NOT (type = 'unlock' AND (success IS NULL OR success != '1'))
     ORDER BY tick ASC`
  ),

  getEventByHash: db.prepare<[string], QsbEventRow>('SELECT * FROM qsb_events WHERE hash = ?'),

  clearEvents: db.prepare('DELETE FROM qsb_events'),
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
  order_hash:  string | null;
  success:     string | null;
  created_at:  string;
}

export function getLastIndexedTick(): number {
  const row = stmts.getMeta.get('last_tick');
  return row ? parseInt(row.value) : 0;
}

export function setLastIndexedTick(tick: number): void {
  stmts.setMeta.run('last_tick', String(tick));
}
