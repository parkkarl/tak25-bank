import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { init, syncBanks, getBanksCache, getBankId, getBankPrefix } from './services/centralBank.js';
import usersRouter from './routes/users.js';
import accountsRouter from './routes/accounts.js';
import transfersRouter, { startRetryWorker } from './routes/transfers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Swagger UI
import { parse } from 'yaml';
const spec = parse(readFileSync(join(__dirname, 'openapi.yaml'), 'utf8'));
const liveUrl = process.env.RENDER_EXTERNAL_URL || process.env.BANK_ADDRESS || null;
if (liveUrl) {
  spec.servers = [{ url: `${liveUrl}/api/v1`, description: 'Live server' }, ...spec.servers];
}
app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));

// Static UI
app.use(express.static(join(__dirname, 'public')));

app.use('/api/v1', usersRouter);
app.use('/api/v1', accountsRouter);
app.use('/api/v1', transfersRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/v1/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/v1/sync', async (req, res) => {
  await syncBanks();
  const banks = getBanksCache();
  res.json({ synced: banks.length, bankId: getBankId(), bankPrefix: getBankPrefix(), banks: banks.map(b => ({ bankId: b.bankId, name: b.name, status: b.status })) });
});

const PORT = process.env.PORT || 3000;
const BANK_NAME = process.env.BANK_NAME || 'TAK25 Bank';
// Render sets RENDER_EXTERNAL_URL automatically
const BANK_ADDRESS = process.env.BANK_ADDRESS || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await init(BANK_NAME, BANK_ADDRESS);
    startRetryWorker();
    console.log('Central bank integration active');
  } catch (e) {
    console.error('Central bank registration failed:', e.message);
    console.log('Running in standalone mode');
  }
});
