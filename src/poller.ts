import { config } from './config.js';
import { db, stmts, getLastIndexedTick, setLastIndexedTick } from './db.js';
import {
  getLastProcessedTick,
  getTransactionsForTick,
  getProcessedTickIntervals,
  querySmartContract,
} from './node-rpc.js';
import { computeContractIdentity, decodeLockInput, queryOrderEra } from './qsb-decoder.js';

let qsbIdentity: string | null = null;

export async function initPoller(): Promise<void> {
  qsbIdentity = await computeContractIdentity(config.qsbContractIndex);
  console.log(`[poller] QSB contract identity: ${qsbIdentity}`);

  // Fast-forward cursor on first run
  if (getLastIndexedTick() === 0) {
    try {
      const intervals = await getProcessedTickIntervals();
      const firstTick = intervals?.[0]?.firstTick;
      if (firstTick && firstTick > 1) {
        setLastIndexedTick(firstTick - 1);
        console.log(`[poller] Fast-forwarded cursor to tick ${firstTick - 1}`);
      }
    } catch { /* node not ready yet */ }
  }

  setInterval(poll, config.pollIntervalMs);
  setInterval(reconcileOrderEras, 10_000);
  setInterval(reconcileUnlockSuccess, 10_000);
  poll();
  reconcileUnlockSuccess();
}

let polling = false;
let lastLoggedTick = 0;

// Log a heartbeat every 30s so it's clear the poller is alive even when caught up
setInterval(() => {
  const tick = getLastIndexedTick();
  console.log(`[poller] heartbeat — at tick ${tick}`);
}, 30_000);

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const { tickNumber: lastProcessed, epoch, intervalInitialTick } = await getLastProcessedTick();
    const lastIndexed = getLastIndexedTick();

    // Detect node restart
    if (lastProcessed < lastIndexed && intervalInitialTick) {
      console.log(`[poller] node restart detected (epoch ${epoch}), resetting cursor to ${intervalInitialTick - 1}`);
      setLastIndexedTick(intervalInitialTick - 1);
      return;
    }

    if (lastProcessed <= lastIndexed) return;

    const lag   = lastProcessed - lastIndexed;
    const batch = lag > 200 ? 50 : 1;
    const from  = lastIndexed + 1;
    const to    = Math.min(lastProcessed, from + batch - 1);

    for (let tick = from; tick <= to; tick++) {
      await indexTick(tick);
    }

    setLastIndexedTick(to);

    if (to > lastLoggedTick) {
      if (to > from) console.log(`[poller] ticks ${from}–${to} indexed (node at ${lastProcessed})`);
      else           console.log(`[poller] tick ${to} indexed`);
      lastLoggedTick = to;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('ECONNREFUSED') && !msg.includes('ENOTFOUND')) {
      console.error('[poller] poll error:', msg);
    }
  } finally {
    polling = false;
  }
}

async function indexTick(tick: number): Promise<void> {
  let txs;
  try {
    txs = await getTransactionsForTick(tick);
  } catch {
    return;
  }

  if (!qsbIdentity) return;

  const insertMany = db.transaction((rows: Parameters<typeof stmts.insertEvent.run>[0][]) => {
    for (const row of rows) stmts.insertEvent.run(row);
  });

  const toInsert: Parameters<typeof stmts.insertEvent.run>[0][] = [];

  for (const tx of txs) {
    if (tx.destination !== qsbIdentity) continue;
    if (tx.inputType !== 1) continue; // only Lock (inputType=1) for now
    if (!tx.inputData) continue;

    const lock = decodeLockInput(tx.inputData);
    if (!lock) continue;

    toInsert.push({
      hash:       tx.hash.toLowerCase(),
      tick,
      type:       'lock',
      source:     tx.source,
      toAddress:  lock.toAddress,
      amount:     lock.amount,
      relayerFee: lock.relayerFee,
      nonce:      String(lock.nonce),
      networkOut: lock.networkOut,
      orderEra:   '0',
    });
  }

  if (toInsert.length > 0) {
    insertMany(toInsert);
    console.log(`[poller] tick ${tick}: ${toInsert.length} QSB Lock event(s) stored`);
  }
}

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

async function reconcileOrderEras(): Promise<void> {
  const pending = stmts.getPendingOrderEras.all();
  for (const { hash, nonce } of pending) {
    const era = await queryOrderEra(config.qsbContractIndex, parseInt(nonce));
    if (era !== '0') {
      stmts.updateOrderEra.run(era, hash);
      console.log(`[poller] resolved orderEra=${era} for tx ${hash}`);
    }
  }
}
