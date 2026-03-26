# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server with tsx (hot reload, uses .env.local)
npm run build      # Compile TypeScript to dist/
npm start          # Run compiled dist/index.js
```

No test runner or linter is configured in this project.

## Architecture

`qs-bridge-indexer` is a lightweight event indexer that polls a Qubic node for bridge transactions, decodes them, persists them in SQLite, and exposes a REST API for downstream bridge services (hub and oracle).

### Data Flow

```
Qubic Node (RPC)
  → Poller (500ms poll) → Node RPC → QSB Decoder → SQLite
                                                      → GET /events           (hub consumes)
                                                      → GET /transactions/:hash (oracle validates)
                                                      → POST /broadcastTransaction (forward + capture)
```

### Key Modules

- **`config.ts`** — Loads env vars (`NODE_URL`, `DB_PATH`, `HTTP_PORT`, `POLL_INTERVAL_MS`, `QSB_CONTRACT_INDEX=26`)
- **`db.ts`** — SQLite setup via `better-sqlite3`; tables: `qsb_events` (indexed Lock events) and `meta` (cursor state). WAL mode enabled.
- **`node-rpc.ts`** — Thin HTTP wrapper around Qubic node RPC: `getLastProcessedTick`, `getTransactionsForTick`, `querySmartContract`, `getProcessedTickIntervals`
- **`qsb-decoder.ts`** — Manual binary buffer parsing for Qubic transaction format:
  - `decodeLockInput()` — 88-byte Lock input: amount, relayerFee, toAddress, networkOut, nonce
  - `decodeTxHeader()` — 80-byte transaction header
  - `isQsbDestination()` — Filters transactions by contract identity
  - `queryOrderEra()` — Queries smart contract via inputType=4
- **`poller.ts`** — Core indexing loop:
  - Batches 50 ticks when catching up, 1 tick when current
  - Detects node restarts (epoch changes) and resets cursor
  - Secondary 10s loop for `reconcileOrderEras()` — lazily resolves order era status
- **`routes.ts`** — Express routes; `/events` returns hub-formatted events, `/transactions/:signature` validates against hub data, `/broadcastTransaction` forwards raw hex/base64 to node and captures any Lock event synchronously
- **`index.ts`** — Entry point: Express setup, routes, poller init

### Important Patterns

- **INSERT OR IGNORE** ensures idempotent event ingestion
- **Cursor fast-forward** on first run avoids re-indexing history (jumps to `lastProcessedTick - 1`)
- **Binary protocol**: Qubic transactions are raw binary; Lock input starts at byte 80 (after 80-byte header), is 88 bytes long, and inputType must be 1
- **QSB contract index** is 26; contract identity is derived from the index (not an address string)
- **Order era** is resolved lazily — events are inserted without it, then a background loop queries the contract and patches the DB
