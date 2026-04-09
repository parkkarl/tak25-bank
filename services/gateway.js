import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import { init } from '../src/services/centralBank.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const USER_SERVICE = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const ACCOUNT_SERVICE = process.env.ACCOUNT_SERVICE_URL || 'http://localhost:3002';
const TRANSFER_SERVICE = process.env.TRANSFER_SERVICE_URL || 'http://localhost:3003';

const app = express();
app.use(express.json());

// Static UI
app.use(express.static(join(__dirname, '..', 'src', 'public')));

// Swagger UI
const spec = parse(readFileSync(join(__dirname, '..', 'src', 'openapi.yaml'), 'utf8'));
const liveUrl = process.env.BANK_ADDRESS || null;
if (liveUrl) {
  const swaggerUrl = liveUrl.endsWith('/api/v1') ? liveUrl : `${liveUrl}/api/v1`;
  spec.servers = [{ url: swaggerUrl, description: 'Live server' }, ...spec.servers];
}
app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));

// Proxy helper
async function proxy(req, res, target) {
  try {
    const url = `${target}${req.originalUrl}`;
    const opts = {
      method: req.method,
      headers: { 'content-type': 'application/json' },
    };
    if (req.headers.authorization) opts.headers.authorization = req.headers.authorization;
    if (!['GET', 'HEAD'].includes(req.method)) opts.body = JSON.stringify(req.body);

    const resp = await fetch(url, opts);
    const data = await resp.text();
    res.status(resp.status).set('content-type', 'application/json').send(data);
  } catch (e) {
    res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: `Service unavailable: ${e.message}` });
  }
}

// Route: users
app.post('/api/v1/users', (req, res) => proxy(req, res, USER_SERVICE));
app.get('/api/v1/users/:userId', (req, res) => proxy(req, res, USER_SERVICE));

// Route: accounts (must be before /users/:id catch-all)
app.post('/api/v1/users/:userId/accounts', (req, res) => proxy(req, res, ACCOUNT_SERVICE));
app.get('/api/v1/users/:userId/accounts', (req, res) => proxy(req, res, ACCOUNT_SERVICE));
app.get('/api/v1/accounts/:accountNumber', (req, res) => proxy(req, res, ACCOUNT_SERVICE));

// Route: transfers
app.post('/api/v1/transfers', (req, res) => proxy(req, res, TRANSFER_SERVICE));
app.post('/api/v1/transfers/receive', (req, res) => proxy(req, res, TRANSFER_SERVICE));
app.get('/api/v1/transfers/:transferId', (req, res) => proxy(req, res, TRANSFER_SERVICE));
app.get('/api/v1/users/:userId/transfers', (req, res) => proxy(req, res, TRANSFER_SERVICE));

// Health check (both paths for central bank compatibility)
app.get('/api/v1/health', (req, res) => res.json({ status: 'ok' }));
app.get('/health', async (req, res) => {
  const check = async (name, url) => {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return { name, status: r.ok ? 'up' : 'down' }; }
    catch { return { name, status: 'down' }; }
  };
  const services = await Promise.all([
    check('user-service', `${USER_SERVICE}/health`),
    check('account-service', `${ACCOUNT_SERVICE}/health`),
    check('transfer-service', `${TRANSFER_SERVICE}/health`),
  ]);
  res.json({ gateway: 'up', services });
});

const PORT = process.env.PORT || 3000;
const BANK_NAME = process.env.BANK_NAME || 'TAK25 Bank';
const BANK_ADDRESS = process.env.BANK_ADDRESS || `http://localhost:${PORT}`;

app.listen(PORT, async () => {
  console.log(`API Gateway on port ${PORT}`);
  console.log(`Swagger UI: http://localhost:${PORT}/docs/`);
  try {
    await init(BANK_NAME, BANK_ADDRESS);
    console.log('Central bank integration active');
  } catch (e) {
    console.error('Central bank registration failed:', e.message);
    console.log('Running in standalone mode');
  }
});
