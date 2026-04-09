import { Router } from 'express';
import db from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { getBankPrefix } from '../services/centralBank.js';

const router = Router();

function genAccountNumber() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 5; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return getBankPrefix() + suffix;
}

router.post('/users/:userId/accounts', authenticate, (req, res) => {
  const { userId } = req.params;
  const { currency } = req.body;

  if (req.user.user_id !== userId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Cannot create account for another user' });
  }
  if (!db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(userId)) {
    return res.status(404).json({ code: 'USER_NOT_FOUND', message: `User with ID '${userId}' not found` });
  }
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Currency is required and must be a valid ISO 4217 code' });
  }

  let accountNumber;
  do { accountNumber = genAccountNumber(); }
  while (db.prepare('SELECT 1 FROM accounts WHERE account_number = ?').get(accountNumber));

  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO accounts (account_number, owner_id, currency, balance, created_at) VALUES (?,?,?,?,?)')
    .run(accountNumber, userId, currency, '10.00', createdAt);

  res.status(201).json({ accountNumber, ownerId: userId, currency, balance: '10.00', createdAt });
});

router.get('/accounts/:accountNumber', (req, res) => {
  const { accountNumber } = req.params;
  if (!/^[A-Z0-9]{8}$/.test(accountNumber)) {
    return res.status(400).json({ code: 'INVALID_ACCOUNT_NUMBER', message: 'Account number must be exactly 8 characters' });
  }

  const row = db.prepare(`
    SELECT a.account_number, u.full_name, a.currency
    FROM accounts a JOIN users u ON a.owner_id = u.user_id
    WHERE a.account_number = ?
  `).get(accountNumber);

  if (!row) {
    return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: `Account with number '${accountNumber}' not found` });
  }

  res.json({ accountNumber: row.account_number, ownerName: row.full_name, currency: row.currency });
});

// List user accounts with balances
router.get('/users/:userId/accounts', authenticate, (req, res) => {
  if (req.user.user_id !== req.params.userId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Not your account' });
  }
  const accounts = db.prepare('SELECT account_number, currency, balance, created_at FROM accounts WHERE owner_id = ?').all(req.params.userId);
  res.json({ accounts });
});

export default router;
