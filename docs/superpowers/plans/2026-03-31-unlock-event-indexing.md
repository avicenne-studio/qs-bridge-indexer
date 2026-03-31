# Unlock Event Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Qubic Unlock transactions (inputType=3) in `POST /broadcastTransaction`, resolve success via `IsOrderFilled`, and emit confirmed unlock events through the existing `GET /events` endpoint.

**Architecture:** Four small, sequential changes — DB schema migration, new decoder functions, broadcast capture in routes, reconciliation loop in poller. Lock event paths are not touched. No hub/oracle changes needed.

**Tech Stack:** TypeScript, better-sqlite3, Node.js fetch (via `querySmartContract`)

---

## File Map

| File | Change |
|------|--------|
| `src/db.ts` | Add `order_hash`/`success` columns; new `insertUnlockEvent`, `updateUnlockSuccess`, `getPendingUnlocks` statements; update `getAllEvents` filter; extend `QsbEventRow` |
| `src/qsb-decoder.ts` | Add `decodeUnlockOrder` and `computeOrderHash` exports |
| `src/routes.ts` | Add unlock capture block; update `toHubEvent` for unlock rows |
| `src/poller.ts` | Add `reconcileUnlockSuccess` function and interval |

---

### Task 1: DB schema migration + statements

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Add migration and new columns**

Replace the `db.exec(...)` block and everything after it in `src/db.ts` with:

```typescript
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
    `UPDATE qsb_events SET success = ? WHERE hash = ? AND type = 'unlock'`
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
```

Note: `getPendingOrderEras` is scoped to `type != 'unlock'` to avoid touching unlock rows with the lock-era reconciliation.

- [ ] **Step 2: Verify the server starts without error**

```bash
cd /path/to/qs-bridge-indexer
npm run dev
```

Expected: server starts, no `ALTER TABLE` errors in output. If "table qsb_events has no column named order_hash" appears, stop — the migration did not run.

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "feat(db): add order_hash and success columns for unlock events"
```

---

### Task 2: Unlock decoder functions

**Files:**
- Modify: `src/qsb-decoder.ts`

- [ ] **Step 1: Add `UnlockOrder` interface and `decodeUnlockOrder` function**

Append to `src/qsb-decoder.ts` after the existing exports:

```typescript
// ── Unlock_input Order decoder ────────────────────────────────────────────────
// Layout of Order struct (188 bytes, all little-endian):
//   [0..31]   id       fromAddress  (ignored in indexer output)
//   [32..63]  id       toAddress    → Qubic recipient
//   [64..95]  uint8[32] tokenIn     (ignored)
//   [96..127] uint8[32] tokenOut    (ignored)
//   [128..135] uint64  amount
//   [136..143] uint64  relayerFee
//   [144..147] uint32  networkIn    (ignored)
//   [148..151] uint32  networkOut
//   [152..183] uint8[32] nonce      → hex string
//   [184..187] uint32  orderEra

export interface UnlockOrder {
  toAddress:  Uint8Array;  // raw 32 bytes — caller converts to identity
  amount:     string;
  relayerFee: string;
  networkOut: number;
  nonce:      string;      // hex string, 64 chars
  orderEra:   number;
}

export function decodeUnlockOrder(payload: Buffer): UnlockOrder | null {
  if (payload.length < 188) return null;

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  return {
    toAddress:  payload.subarray(32, 64),
    amount:     view.getBigUint64(128, true).toString(),
    relayerFee: view.getBigUint64(136, true).toString(),
    networkOut: view.getUint32(148, true),
    nonce:      Buffer.from(payload.subarray(152, 184)).toString('hex'),
    orderEra:   view.getUint32(184, true),
  };
}

// ── ComputeOrderHash (inputType=6) ────────────────────────────────────────────
// Input:  188-byte Order struct as hex
// Output: 32-byte OrderHash (base64-encoded in responseData)

export async function computeOrderHash(
  contractIndex: number,
  orderBytes: Buffer,
): Promise<string | null> {
  try {
    const res = await querySmartContract(contractIndex, 6, orderBytes.toString('hex'));
    if (!res.responseData) return null;
    const out = Buffer.from(res.responseData, 'base64');
    if (out.length < 32) return null;
    return out.subarray(0, 32).toString('hex');
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected: exits 0, no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/qsb-decoder.ts
git commit -m "feat(decoder): add decodeUnlockOrder and computeOrderHash"
```

---

### Task 3: Broadcast capture for Unlock (routes.ts)

**Files:**
- Modify: `src/routes.ts`

- [ ] **Step 1: Update imports**

Change the import from `./qsb-decoder.js` to include the new functions:

```typescript
import { decodeLockInput, pubKeyToIdentity, isQsbDestination, decodeUnlockOrder, computeOrderHash } from './qsb-decoder.js';
```

Change the import from `./db.js` to include `insertUnlockEvent`:

```typescript
import { stmts, getLastIndexedTick, type QsbEventRow } from './db.js';
```

(No change needed — `stmts` already imports everything; `insertUnlockEvent` is now on `stmts`.)

- [ ] **Step 2: Add unlock capture block in `broadcastTransaction`**

The existing lock capture is inside `if (rawBuf.length >= 80) { try { const header = decodeTxHeader(rawBuf); ... } }`.
The unlock capture must go **inside the same try block** to reuse `header`. Replace the entire capture block with:

```typescript
  // Capture QSB Lock / Unlock event from raw binary
  if (rawBuf.length >= 80) {
    try {
      const header = decodeTxHeader(rawBuf);

      if (isQsbDestination(header.destPubKey, config.qsbContractIndex) && header.inputType === 1) {
        // ── Lock ──
        const payloadBase64 = rawBuf.subarray(80, 80 + header.inputSize).toString('base64');
        const lock = decodeLockInput(payloadBase64);
        const hash = ((nodeResponse.transactionId as string) ?? '').toLowerCase();

        if (lock && hash) {
          const sourceId = await pubKeyToIdentity(header.sourcePubKey);
          stmts.insertEvent.run({
            hash,
            tick:       header.tick,
            type:       'lock',
            source:     sourceId ?? '',
            toAddress:  lock.toAddress,
            amount:     lock.amount,
            relayerFee: lock.relayerFee,
            nonce:      String(lock.nonce),
            networkOut: lock.networkOut,
            orderEra:   '0',
          });
          console.log(`[broadcast] captured QSB Lock tx ${hash} (nonce=${lock.nonce}, amount=${lock.amount})`);
        }

      } else if (isQsbDestination(header.destPubKey, config.qsbContractIndex) &&
                 header.inputType === 3 &&
                 header.inputSize >= 188 &&
                 rawBuf.length >= 268) {
        // ── Unlock ──
        const payloadBuf = rawBuf.subarray(80, 80 + header.inputSize);
        const order      = decodeUnlockOrder(payloadBuf);
        const hash       = ((nodeResponse.transactionId as string) ?? '').toLowerCase();

        if (order && hash) {
          const sourceId  = await pubKeyToIdentity(header.sourcePubKey);
          const toId      = await pubKeyToIdentity(order.toAddress);
          const orderHash = await computeOrderHash(config.qsbContractIndex, Buffer.from(payloadBuf.subarray(0, 188)));

          stmts.insertUnlockEvent.run({
            hash,
            tick:       header.tick,
            type:       'unlock',
            source:     sourceId ?? '',
            toAddress:  toId     ?? '',
            amount:     order.amount,
            relayerFee: order.relayerFee,
            nonce:      order.nonce,
            networkOut: order.networkOut,
            orderEra:   String(order.orderEra),
            orderHash:  orderHash ?? null,
          });
          console.log(`[broadcast] captured QSB Unlock tx ${hash} (nonce=${order.nonce})`);
        }
      }
    } catch (err: unknown) {
      console.warn('[broadcast] QSB capture failed:', err instanceof Error ? err.message : err);
    }
  }
```

- [ ] **Step 3: Update `toHubEvent` to handle unlock rows**

Replace the existing `toHubEvent` function with:

```typescript
function toHubEvent(row: QsbEventRow) {
  if (row.type === 'unlock') {
    return {
      chain:   'qubic' as const,
      type:    row.type,
      nonce:   row.nonce,
      trxHash: row.hash,
      payload: {
        toAddress: row.to_address,
        amount:    row.amount,
        nonce:     row.nonce,
      },
    };
  }
  return {
    chain:   'qubic' as const,
    type:    row.type,
    nonce:   row.nonce,
    trxHash: row.hash,
    payload: {
      fromAddress: row.source,
      toAddress:   row.to_address,
      amount:      row.amount,
      relayerFee:  row.relayer_fee,
      nonce:       row.nonce,
      orderEra:    row.order_era,
    },
  };
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts
git commit -m "feat(routes): capture QSB Unlock events on broadcast, filter pending from /events"
```

---

### Task 4: Reconciliation loop (poller.ts)

**Files:**
- Modify: `src/poller.ts`

- [ ] **Step 1: Update imports**

In `src/poller.ts`, update the import from `./node-rpc.js` to include `querySmartContract`:

```typescript
import {
  getLastProcessedTick,
  getTransactionsForTick,
  getProcessedTickIntervals,
  querySmartContract,
} from './node-rpc.js';
```

Update the import from `./db.js` to include the new statements:

```typescript
import { db, stmts, getLastIndexedTick, setLastIndexedTick } from './db.js';
```

(No change needed for the db import — `stmts` already has the new statements.)

- [ ] **Step 2: Add `reconcileUnlockSuccess` function**

Append to `src/poller.ts` after the existing `reconcileOrderEras` function:

```typescript
async function reconcileUnlockSuccess(): Promise<void> {
  const pending = stmts.getPendingUnlocks.all();
  if (pending.length === 0) return;

  let currentTick: number;
  try {
    ({ tickNumber: currentTick } = await getLastProcessedTick());
  } catch {
    return; // node not reachable; retry next interval
  }

  for (const row of pending) {
    if (currentTick <= row.tick + 5) continue; // tick not yet safely finalized

    try {
      const res = await querySmartContract(config.qsbContractIndex, 5, row.order_hash);
      if (!res.responseData) continue;

      const out    = Buffer.from(res.responseData, 'base64');
      const filled = out.length > 0 && out[0] === 1;

      stmts.updateUnlockSuccess.run(filled ? '1' : '0', row.hash);
      console.log(`[poller] unlock ${row.hash}: success=${filled}`);
    } catch {
      // RPC error — retry next interval
    }
  }
}
```

- [ ] **Step 3: Wire up the interval in `initPoller`**

In `initPoller`, add the new interval alongside the existing `reconcileOrderEras` interval:

```typescript
  setInterval(poll, config.pollIntervalMs);
  setInterval(reconcileOrderEras, 10_000);
  setInterval(reconcileUnlockSuccess, 10_000);
  poll();
  reconcileUnlockSuccess();
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/poller.ts
git commit -m "feat(poller): reconcile unlock success via IsOrderFilled"
```

---

### Task 5: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the indexer locally pointing at testnet**

```bash
cd /path/to/qs-bridge-indexer
npm run dev
```

Expected output includes:
```
[indexer] QSB bridge indexer on http://0.0.0.0:3002
[poller] QSB contract identity: BBAAAA...
```

- [ ] **Step 2: Broadcast an Unlock transaction via the indexer**

```bash
curl -X POST http://localhost:3002/broadcastTransaction \
  -H 'Content-Type: application/json' \
  -d '{"encodedTransaction":"<base64-encoded-unlock-tx>"}'
```

Expected log line:
```
[broadcast] captured QSB Unlock tx <hash> (nonce=<64-char-hex>)
```

- [ ] **Step 3: Verify the event is NOT yet in /events (pending)**

```bash
curl http://localhost:3002/events
```

Expected: the unlock tx hash does NOT appear (success is still null).

- [ ] **Step 4: Wait for reconciliation (~15s after the target tick passes)**

Watch logs for:
```
[poller] unlock <hash>: success=true
```
or
```
[poller] unlock <hash>: success=false
```

- [ ] **Step 5: Verify successful unlock appears in /events**

```bash
curl http://localhost:3002/events
```

Expected (for a successful unlock):
```json
[
  {
    "chain": "qubic",
    "type": "unlock",
    "nonce": "<64-char-hex>",
    "trxHash": "<hash>",
    "payload": {
      "toAddress": "<qubic-identity>",
      "amount": "<amount>",
      "nonce": "<64-char-hex>"
    }
  }
]
```

- [ ] **Step 6: Verify failed unlock does NOT appear in /events**

If `success=false` was logged, confirm the event is absent from `GET /events`.

- [ ] **Step 7: Check /status for event count**

```bash
curl http://localhost:3002/status
```

Expected: `eventCount` reflects only confirmed (success='1') unlock events + all lock events.
