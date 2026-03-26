export const config = {
  nodeUrl:           process.env.NODE_URL           ?? 'http://localhost:41841',
  dbPath:            process.env.DB_PATH            ?? './data/indexer.db',
  httpPort:          parseInt(process.env.HTTP_PORT          ?? '3002'),
  pollIntervalMs:    parseInt(process.env.POLL_INTERVAL_MS   ?? '500'),
  qsbContractIndex:  parseInt(process.env.QSB_CONTRACT_INDEX ?? '26'),
} as const;
