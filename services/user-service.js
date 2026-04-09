import express from 'express';
import { v4 as uuid } from 'uuid';
import db from '../src/db.js';

const app = express();
app.use(express.json());

app.post('/api/v1/users', (req, res) => {
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

app.get('/api/v1/users/:userId', (req, res) => {
  // Authenticate
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication is required' });
  }
  const authUser = db.prepare('SELECT user_id FROM users WHERE api_key = ?').get(auth.slice(7));
  if (!authUser) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid token' });
  if (authUser.user_id !== req.params.userId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'You can only view your own profile' });
  }

  const user = db.prepare('SELECT user_id, full_name, email, created_at FROM users WHERE user_id = ?').get(req.params.userId);
  if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found' });

  const accounts = db.prepare('SELECT account_number, currency, balance, created_at FROM accounts WHERE owner_id = ?').all(user.user_id);
  const resp = { userId: user.user_id, fullName: user.full_name, createdAt: user.created_at, accounts };
  if (user.email) resp.email = user.email;
  res.json(resp);
});

// Internal endpoint: validate token
app.get('/internal/auth', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication is required' });
  const user = db.prepare('SELECT user_id, full_name, email, created_at FROM users WHERE api_key = ?').get(auth.slice(7));
  if (!user) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid token' });
  res.json(user);
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'user-service' }));

const PORT = process.env.USER_SERVICE_PORT || 3001;
app.listen(PORT, () => console.log(`User service on port ${PORT}`));
