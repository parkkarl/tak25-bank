import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { init } from './services/centralBank.js';
import usersRouter from './routes/users.js';
import accountsRouter from './routes/accounts.js';
import transfersRouter, { startRetryWorker } from './routes/transfers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Swagger UI
import { parse } from 'yaml';
const spec = parse(readFileSync(join(__dirname, 'openapi.yaml'), 'utf8'));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));

app.use('/api/v1', usersRouter);
app.use('/api/v1', accountsRouter);
app.use('/api/v1', transfersRouter);

const PORT = process.env.PORT || 3000;
const BANK_NAME = process.env.BANK_NAME || 'TAK25 Bank';
const BANK_ADDRESS = process.env.BANK_ADDRESS || `http://localhost:${PORT}`;

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
