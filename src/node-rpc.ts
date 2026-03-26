import { config } from './config.js';

async function rpcGet<T>(path: string): Promise<T> {
  const res = await fetch(`${config.nodeUrl}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function rpcPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${config.nodeUrl}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export interface LastProcessedTick {
  tickNumber:          number;
  epoch:               number;
  intervalInitialTick: number;
}

export interface NodeTransaction {
  hash:        string;
  source:      string;
  destination: string;
  amount:      number;
  tickNumber:  number;
  inputType:   number;
  inputSize:   number;
  inputData:   string; // base64
}

export async function getLastProcessedTick(): Promise<LastProcessedTick> {
  return rpcGet<LastProcessedTick>('/getLastProcessedTick');
}

export async function getTransactionsForTick(tickNumber: number): Promise<NodeTransaction[]> {
  const res = await rpcPost<{ transactions?: NodeTransaction[] }>(
    '/getTransactionsForTick',
    { tickNumber },
  );
  return res.transactions ?? [];
}

export async function querySmartContract(
  contractIndex: number,
  inputType: number,
  inputHex: string,
): Promise<{ responseData?: string }> {
  return rpcPost('/live/v1/querySmartContract', { contractIndex, inputType, inputHex });
}

export async function getProcessedTickIntervals(): Promise<Array<{ firstTick: number }>> {
  return rpcGet('/getProcessedTickIntervals');
}
