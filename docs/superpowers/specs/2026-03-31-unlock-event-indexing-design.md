# Unlock Event Indexing Design

**Date:** 2026-03-31
**Scope:** `qs-bridge-indexer`

## Context

The indexer currently captures only `lock` events (inputType=1) from `POST /broadcastTransaction`. The hub and oracle already have `"unlock"` in their event type schemas and expect unlock events from `GET /events`, but the indexer never emits them.

Unlock (inputType=3) is a Solana→Qubic bridge operation: oracles aggregate signatures over an `Order` struct and call `Unlock` on the contract. The contract releases QU to the Qubic recipient. Success or failure is determined by querying `IsOrderFilled` (view function inputType=5) after the tick is processed.

The node does not expose contract logs via HTTP, so success cannot be read from the `QSBLogUnlockMessage` directly.

## Approach

Extend the existing `qsb_events` table with two nullable columns (`order_hash`, `success`) and add unlock capture + reconciliation alongside the existing lock infrastructure. All unlock events flow through `GET /events` once confirmed successful — no new endpoints needed.

## Data Model

### Schema changes

```sql
ALTER TABLE qsb_events ADD COLUMN order_hash TEXT;
-- 32-byte hex of the order hash; used for IsOrderFilled reconciliation
-- null for lock events

ALTER TABLE qsb_events ADD COLUMN success TEXT;
-- null = pending reconciliation
-- '1'  = unlock confirmed successful (IsOrderFilled returned true)
-- '0'  = unlock failed (IsOrderFilled returned false after tick+5)
-- null for lock events (not applicable)
```

### Unlock row field mapping

| column | source | notes |
|--------|--------|-------|
| `hash` | tx hash from node broadcast response | |
| `tick` | tx header bytes 72–75 (uint32 LE) | |
| `type` | `'unlock'` | |
| `source` | tx `sourcePubKey` → Qubic identity | relayer address |
| `to_address` | `Order.toAddress` (bytes 32–63) → Qubic identity | Qubic recipient |
| `amount` | `Order.amount` (bytes 128–135, uint64 LE) | |
| `relayer_fee` | `Order.relayerFee` (bytes 136–143, uint64 LE) | stored; not in hub payload |
| `nonce` | `Order.nonce` (bytes 152–183) → hex string | used by oracle as `sourceNonce` |
| `network_out` | `Order.networkOut` (bytes 148–151, uint32 LE) | |
| `order_era` | `Order.orderEra` (bytes 184–187, uint32 LE) | available directly; no async needed |
| `order_hash` | `ComputeOrderHash` RPC (inputType=6) result | 32-byte hex |
| `success` | `null` at insert; resolved by reconciliation | |

### `Unlock_input.order` byte layout (payload starts at byte 80 of raw tx)

```
[0..31]   fromAddress  id (32 bytes) — ignored in indexer output
[32..63]  toAddress    id (32 bytes) → Qubic identity → to_address
[64..95]  tokenIn      Array<uint8,32> — ignored
[96..127] tokenOut     Array<uint8,32> — ignored
[128..135] amount      uint64 LE
[136..143] relayerFee  uint64 LE
[144..147] networkIn   uint32 LE — ignored
[148..151] networkOut  uint32 LE
[152..183] nonce       Array<uint8,32> → hex string
[184..187] orderEra    uint32 LE
```
Total Order size: 188 bytes. `inputSize` must be ≥ 188.

## Broadcast Capture (`routes.ts`)

On `POST /broadcastTransaction`, when `header.inputType === 3`:

1. Decode `Order` from `rawBuf.subarray(80, 268)` (bytes 80–267 of raw tx)
2. Call `ComputeOrderHash` via `querySmartContract(contractIndex, 6, orderHex)` — input is the 188-byte Order as hex; output is 32-byte `OrderHash` (base64 → hex)
3. Convert `order.toAddress` bytes → identity string via `pubKeyToIdentity`
4. Insert into `qsb_events` with `success=null`, `order_hash=<hex>`
5. Log: `[broadcast] captured QSB Unlock tx <hash> (nonce=<hex>)`

If `ComputeOrderHash` fails (RPC error), still insert the row with `order_hash=null` — reconciliation will be skipped and the row stays pending. This is an acceptable degraded state.

## Reconciliation (`poller.ts`)

New function `reconcileUnlockSuccess`, runs every 10s alongside `reconcileOrderEras`.

```
1. SELECT rows WHERE type='unlock' AND success IS NULL AND order_hash IS NOT NULL
2. GET current tick from getLastProcessedTick()
3. For each row WHERE current_tick > row.tick + 5:
   a. Call IsOrderFilled (querySmartContract inputType=5) with order_hash bytes (32 bytes as hex)
      Output: 1 byte — bit (0x01 = filled, 0x00 = not filled)
   b. filled=true  → UPDATE success='1'
   c. filled=false → UPDATE success='0'
```

The `+5 tick` buffer ensures the tick has been fully processed by the node before querying.

## `GET /events` Changes

**Filter:** exclude unlock rows that are not yet confirmed:
```sql
WHERE NOT (type = 'unlock' AND (success IS NULL OR success != '1'))
```
i.e. unlock rows only appear once `success='1'`.

**`toHubEvent` for unlock rows:**
```typescript
{
  chain:   'qubic',
  type:    'unlock',
  nonce:   row.nonce,        // hex string (32 bytes)
  trxHash: row.hash,
  payload: {
    toAddress: row.to_address,
    amount:    row.amount,
    nonce:     row.nonce,
  }
}
```
This matches `QubicUnlockEventPayloadSchema` in both hub and oracle.

## New DB Statements

- `insertEvent` — already used; `order_hash` and `success` default to null, no change needed if using named params
- `updateUnlockSuccess` — `UPDATE qsb_events SET success = ? WHERE hash = ? AND type = 'unlock'`
- `getPendingUnlocks` — `SELECT hash, tick, order_hash FROM qsb_events WHERE type='unlock' AND success IS NULL AND order_hash IS NOT NULL`

## New `qsb-decoder.ts` exports

- `decodeUnlockOrder(payload: Buffer): UnlockOrder | null` — decodes the 188-byte Order struct
- `computeOrderHash(contractIndex: number, orderHex: string): Promise<string | null>` — calls `ComputeOrderHash` via RPC, returns hex string or null on failure

## What does NOT change

- Lock event capture and reconciliation — untouched
- `reconcileOrderEras` — untouched
- Hub/oracle code — no changes needed; their schemas already support `"unlock"`
- Poller tick-scanning path — unlock events only come via broadcast, not tick scanning (same as lock)
