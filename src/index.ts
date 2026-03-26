import express from 'express';
import { config } from './config.js';
import { router } from './routes.js';
import { initPoller } from './poller.js';

const app = express();
app.use(express.json());
app.use(router);

app.listen(config.httpPort, () => {
  console.log(`[indexer] QSB bridge indexer on http://0.0.0.0:${config.httpPort}`);
  console.log(`[indexer] Node: ${config.nodeUrl} | DB: ${config.dbPath}`);
});

initPoller().catch((err: unknown) => {
  console.error('[indexer] Failed to initialize poller:', err);
  process.exit(1);
});
