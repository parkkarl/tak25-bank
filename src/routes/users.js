import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';

const router = Router();

router.post('/users', (req, res) => {
  const { fullName, email } = req.body;
  if (!fullName || fullName.length < 2) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Full name is required' });
  }
  if (email) {
    const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
    if (exists) {
      return res.status(409).json({ code: 'DUPLICATE_USER', message: 'A user with this email address is already registered' });
    }
  }

  const userId = `user-${uuid()}`;
  const apiKey = uuid();
  const createdAt = new Date().toISOString();

  db.prepare('INSERT INTO users (user_id, full_name, email, api_key, created_at) VALUES (?,?,?,?,?)')
    .run(userId, fullName, email || null, apiKey, createdAt);

  const resp = { userId, fullName, createdAt, apiKey };
  if (email) resp.email = email;
  res.status(201).json(resp);
});

router.get('/users/:userId', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(req.params.userId);
  if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found' });

  const accounts = db.prepare('SELECT account_number, currency, balance, created_at FROM accounts WHERE owner_id = ?').all(user.user_id);
  const resp = { userId: user.user_id, fullName: user.full_name, createdAt: user.created_at, accounts };
  if (user.email) resp.email = user.email;
  res.json(resp);
});

export default router;
