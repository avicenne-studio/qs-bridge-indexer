import { Router, Request, Response } from 'express';
import { stmts, getLastIndexedTick, type QsbEventRow } from './db.js';
import { config } from './config.js';
import { decodeLockInput, pubKeyToIdentity, isQsbDestination, decodeUnlockOrder, computeOrderHash } from './qsb-decoder.js';

export const router = Router();

// ── Transaction binary layout (80-byte header) ────────────────────────────────
// [0..31]  sourcePublicKey
// [32..63] destinationPublicKey
// [64..71] amount (int64 LE)
// [72..75] tick (uint32 LE)
// [76..77] inputType (uint16 LE)
// [78..79] inputSize (uint16 LE)
// [80..]   payload

function decodeTxHeader(buf: Buffer) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    sourcePubKey: buf.subarray(0, 32),
    destPubKey:   buf.subarray(32, 64),
    tick:         view.getUint32(72, true),
    inputType:    view.getUint16(76, true),
    inputSize:    view.getUint16(78, true),
  };
}

// ── POST /broadcastTransaction ────────────────────────────────────────────────
// Forwards to the Qubic node and captures QSB Lock events from the raw binary.
// Accepts: { data: "hex..." } or { encodedTransaction: "base64..." }

router.post('/broadcastTransaction', async (req: Request, res: Response) => {
  const { data, encodedTransaction } = (req.body ?? {}) as Record<string, string>;

  let rawBuf: Buffer;
  let base64Encoded: string;

  if (data) {
    const hex = data.startsWith('0x') ? data.slice(2) : data;
    rawBuf = Buffer.from(hex, 'hex');
    base64Encoded = rawBuf.toString('base64');
  } else if (encodedTransaction) {
    rawBuf = Buffer.from(encodedTransaction, 'base64');
    base64Encoded = encodedTransaction;
  } else {
    res.status(400).json({ ok: false, error: 'Missing data or encodedTransaction' });
    return;
  }

  // Forward to node
  let nodeResponse: Record<string, unknown>;
  try {
    const r = await fetch(`${config.nodeUrl}/live/v1/broadcast-transaction`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ encodedTransaction: base64Encoded }),
    });
    nodeResponse = await r.json() as Record<string, unknown>;
  } catch (err: unknown) {
    res.status(502).json({ ok: false, error: `Node unreachable: ${err instanceof Error ? err.message : err}` });
    return;
  }

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

  res.json(nodeResponse);
});

// ── GET /status ───────────────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  const lastIndexedTick = getLastIndexedTick();
  const eventCount = (stmts.getAllEvents.all() as QsbEventRow[]).length;
  res.json({ lastIndexedTick, eventCount });
});

// ── GET /events ───────────────────────────────────────────────────────────────
// Hub polls this for QSB Lock events.
// Returns array in hub's QubicEvent format.

router.get('/events', (_req: Request, res: Response) => {
  const rows = stmts.getAllEvents.all() as QsbEventRow[];
  res.json(rows.map(toHubEvent));
});

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

// ── GET /transactions/:signature ──────────────────────────────────────────────
// Oracle calls this to validate a Qubic transaction matches what the hub reported.
// Query param: expected (JSON string)

interface QubicExpected {
  type:    string;
  nonce:   string;
  payload: {
    fromAddress: string;
    toAddress:   string;
    amount:      string;
    relayerFee:  string;
    nonce:       string;
    orderEra:    string;
  };
}

router.get('/transactions/:signature', (req: Request, res: Response) => {
  const hash = (Array.isArray(req.params.signature) ? req.params.signature[0] : req.params.signature).toLowerCase();
  const row = stmts.getEventByHash.get(hash);

  if (!row) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }

  let matches = false;
  const raw = req.query['expected'];

  if (typeof raw === 'string') {
    try {
      const expected = JSON.parse(raw) as QubicExpected;
      matches =
        expected.type                    === row.type        &&
        String(expected.nonce)           === row.nonce       &&
        expected.payload?.fromAddress    === row.source      &&
        expected.payload?.toAddress      === row.to_address  &&
        expected.payload?.amount         === row.amount      &&
        expected.payload?.relayerFee     === row.relayer_fee &&
        String(expected.payload?.nonce)  === row.nonce       &&
        String(expected.payload?.orderEra) === row.order_era;
    } catch {
      matches = false;
    }
  }

  res.json({ trxHash: hash, matches });
});
