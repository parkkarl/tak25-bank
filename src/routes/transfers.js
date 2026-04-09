import { Router } from 'express';
import db from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { getBankPrefix } from '../services/centralBank.js';
import {
  validateAmount, executeSameBankTransfer, executeCrossBankTransfer,
  receiveTransfer, getTransferStatus, getUserTransfers, retryPendingTransfers
} from '../logic/transfers.js';

const router = Router();

router.post('/transfers', authenticate, async (req, res) => {
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

router.post('/transfers/receive', async (req, res) => {
  try {
    const result = await receiveTransfer(req.body.jwt);
    if (result.error) return res.status(result.error.status).json({ code: result.error.code, message: result.error.message });
    res.json(result.data);
  } catch (e) {
    console.error('Receive error:', e);
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid JWT signature' });
  }
});

router.get('/transfers/:transferId', authenticate, (req, res) => {
  const result = getTransferStatus(req.params.transferId, req.user.user_id);
  if (result.error) return res.status(result.error.status).json({ code: result.error.code, message: result.error.message });
  res.json(result.data);
});

router.get('/users/:userId/transfers', authenticate, (req, res) => {
  if (req.user.user_id !== req.params.userId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Not authorized' });
  }
  const result = getUserTransfers(req.params.userId);
  res.json(result.data);
});

export function startRetryWorker() {
  setInterval(retryPendingTransfers, 30000);
}

export default router;
