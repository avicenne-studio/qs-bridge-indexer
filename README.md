# qs-bridge-indexer

Lightweight event indexer for the Qubic-Solana bridge. Polls a Qubic node for `QubicSolanaBridge` (QSB) transactions, decodes the binary protocol, persists events in SQLite, and exposes a REST API consumed by the hub and oracle.

## Architecture

```
Qubic Node (RPC)
  → Poller (500ms) → QSB Decoder → SQLite
                                    → GET /events                  (hub)
                                    → GET /transactions/:hash      (oracle)
                                    → POST /broadcastTransaction   (forward + capture)
```

- **Poller** — batches 50 ticks when catching up, 1 tick at chain tip. Detects epoch changes (node restarts) and resets cursor. A secondary 10 s loop lazily resolves order era status.
- **Decoder** — parses the 80-byte transaction header + 88-byte Lock input (amount, relayerFee, toAddress, networkOut, nonce).
- **DB** — SQLite (WAL mode) with two tables: `qsb_events` and `meta` (cursor state). Inserts are idempotent (`INSERT OR IGNORE`).

## Setup

```bash
cp .env.example .env.local
# edit .env.local as needed
npm install
```

## Commands

```bash
npm run dev    # Hot-reload dev server (tsx, reads .env.local)
npm run build  # Compile TypeScript → dist/
npm start      # Run dist/index.js
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `NODE_URL` | `http://localhost:41841` | Qubic node RPC base URL |
| `DB_PATH` | `./data/indexer.db` | SQLite database path |
| `HTTP_PORT` | `3002` | HTTP server port |
| `POLL_INTERVAL_MS` | `500` | Tick poll interval |
| `QSB_CONTRACT_INDEX` | `26` | QubicSolanaBridge contract index |

## API

### `GET /events`

Returns decoded Lock events. Consumed by the hub to track pending bridge orders.

### `GET /transactions/:hash`

Returns a single transaction by hash. Used by the oracle for validation.

### `POST /broadcastTransaction`

Forwards a raw transaction (hex or base64) to the Qubic node and synchronously captures any resulting Lock event.
