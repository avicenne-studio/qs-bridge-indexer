import qubicLib from '@qubic-lib/qubic-ts-library';
import { querySmartContract } from './node-rpc.js';

const { QubicHelper } = (qubicLib as any).default ?? qubicLib;
const helper = new QubicHelper();

// ── Lock_input decoder ────────────────────────────────────────────────────────
// Layout (88 bytes, all little-endian):
//   [0..7]   uint64  amount
//   [8..15]  uint64  relayerFee
//   [16..79] uint8[64] toAddress (zero-padded ASCII)
//   [80..83] uint32  networkOut
//   [84..87] uint32  nonce

export interface LockInput {
  amount:     string;
  relayerFee: string;
  toAddress:  string;
  networkOut: number;
  nonce:      number;
}

export function decodeLockInput(base64Data: string): LockInput | null {
  const buf = Buffer.from(base64Data, 'base64');
  if (buf.length < 88) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  return {
    amount:     view.getBigUint64(0,  true).toString(),
    relayerFee: view.getBigUint64(8,  true).toString(),
    toAddress:  buf.subarray(16, 80).toString('ascii').replace(/\0+$/, ''),
    networkOut: view.getUint32(80, true),
    nonce:      view.getUint32(84, true),
  };
}

// ── Identity helpers ──────────────────────────────────────────────────────────

export async function pubKeyToIdentity(bytes: Uint8Array): Promise<string | null> {
  try { return await helper.getIdentity(bytes); } catch { return null; }
}

export async function computeContractIdentity(index: number): Promise<string> {
  const buf = new Uint8Array(32);
  let v = BigInt(index);
  for (let i = 0; i < 8; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return helper.getIdentity(buf);
}

export function isQsbDestination(destBytes: Uint8Array, contractIndex: number): boolean {
  if (destBytes[0] !== contractIndex) return false;
  for (let i = 1; i < 32; i++) if (destBytes[i] !== 0) return false;
  return true;
}

// ── OrderEra query ────────────────────────────────────────────────────────────
// GetLockedOrder (inputType=4): input = uint32 nonce (4 bytes LE)
// Output = 1 byte exists + LockedOrderEntry (161 bytes)
//
// LockedOrderEntry layout (QubicSolanaBridge.h:132-144):
//   sender(32) + amount(8) + relayerFee(8) + networkOut(4) + nonce(4)
//   + toAddress(64) + orderHash(32) + lockEpoch(4) + orderEra(4) + active(1)
//   = 161 bytes
//
// orderEra offset in full output: 1 (exists) + 32+8+8+4+4+64+32+4 = 1+156 = 157

export async function queryOrderEra(
  contractIndex: number,
  nonce: number,
): Promise<string> {
  try {
    const inputBuf = Buffer.alloc(4);
    inputBuf.writeUInt32LE(nonce);
    const inputHex = inputBuf.toString('hex');

    const res = await querySmartContract(contractIndex, 4, inputHex);
    if (!res.responseData) return '0';

    const out = Buffer.from(res.responseData, 'base64');
    if (out.length < 162) return '0';

    const exists = out[0];
    if (!exists) return '0';

    return String(out.readUInt32LE(157));
  } catch {
    return '0';
  }
}

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
    toAddress:  Uint8Array.prototype.slice.call(payload, 32, 64),
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
