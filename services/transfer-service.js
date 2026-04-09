import express from 'express';
import db from '../src/db.js';
import {
  validateAmount, executeSameBankTransfer, executeCrossBankTransfer,
  receiveTransfer, getTransferStatus, getUserTransfers, retryPendingTransfers
} from '../src/logic/transfers.js';
import { getBankPrefix } from '../src/services/centralBank.js';

const app = express();
app.use(express.json());

const USER_SERVICE = process.env.USER_SERVICE_URL || 'http://localhost:3001';

async function authenticate(req, res, next) {
  try {
    const resp = await fetch(`${USER_SERVICE}/internal/auth`, { headers: { authorization: req.headers.authorization || '' } });
    if (!resp.ok) { const err = await resp.json(); return res.status(resp.status).json(err); }
    req.user = await resp.json();
    next();
  } catch { res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'User service unavailable' }); }
}

app.post('/api/v1/transfers', authenticate, async (req, res) => {
  const { transferId, sourceAccount, destinationAccount, amount } = req.body;

  if (!transferId || !sourceAccount || !destinationAccount || !amount) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing required fields' });
  }
  const amountErr = validateAmount(amount);
  if (amountErr) return res.status(400).json({ code: 'INVALID_REQUEST', message: amountErr });

  const existing = db.prepare('SELECT * FROM transfers WHERE transfer_id = ?').get(transferId);
  if (existing) {
    const code = existing.status === 'pending' ? 'TRANSFER_ALREADY_PENDING' : 'DUPLICATE_TRANSFER';
    return res.status(409).json({ code, message: `Transfer '${transferId}' already exists` });
  }

  const src = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(sourceAccount);
  if (!src) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Source account not found' });
  if (src.owner_id !== req.user.user_id) return res.status(403).json({ code: 'FORBIDDEN', message: 'Not your account' });

  const destPrefix = destinationAccount.substring(0, 3);

  let result;
  if (destPrefix === getBankPrefix()) {
    result = await executeSameBankTransfer({ transferId, sourceAccount, destinationAccount, amount });
  } else {
    result = await executeCrossBankTransfer({ transferId, sourceAccount, destinationAccount, amount, userId: req.user.user_id });
  }

  if (result.error) return res.status(result.error.status).json({ code: result.error.code, message: result.error.message });
  return res.status(result.status || 201).json(result.data);
});

app.post('/api/v1/transfers/receive', async (req, res) => {
  try {
    console.log('Receive body:', JSON.stringify(req.body));
    const token = req.body.jwt || req.body.token || (typeof req.body === 'string' ? req.body : null);
    const result = await receiveTransfer(token);
    if (result.error) return res.status(result.error.status).json({ code: result.error.code, message: result.error.message });
    res.json(result.data);
  } catch (e) {
    console.error('Receive error:', e);
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid JWT signature' });
  }
});

app.get('/api/v1/transfers/:transferId', authenticate, (req, res) => {
  const result = getTransferStatus(req.params.transferId, req.user.user_id);
  if (result.error) return res.status(result.error.status).json({ code: result.error.code, message: result.error.message });
  res.json(result.data);
});

app.get('/api/v1/users/:userId/transfers', authenticate, (req, res) => {
  if (req.user.user_id !== req.params.userId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Not authorized' });
  }
  const result = getUserTransfers(req.params.userId);
  res.json(result.data);
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'transfer-service' }));

function startRetryWorker() {
  setInterval(retryPendingTransfers, 30000);
}

const PORT = process.env.TRANSFER_SERVICE_PORT || 3003;
app.listen(PORT, () => {
  console.log(`Transfer service on port ${PORT}`);
  startRetryWorker();
});
