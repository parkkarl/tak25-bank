import express from 'express';
import { v4 as uuid } from 'uuid';
import db from '../src/db.js';
import {
  getBankPrefix, getBankId, findBankByPrefix,
  getExchangeRates, signJwt, verifyJwt, getBanksCache
} from '../src/services/centralBank.js';

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
  if (typeof amount !== 'string' || !/^\d+\.\d{2}$/.test(amount) || parseFloat(amount) <= 0 || !isFinite(parseFloat(amount))) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Amount must be a positive number with 2 decimal places (e.g. "100.00")' });
  }

  const existing = db.prepare('SELECT * FROM transfers WHERE transfer_id = ?').get(transferId);
  if (existing) {
    const code = existing.status === 'pending' ? 'TRANSFER_ALREADY_PENDING' : 'DUPLICATE_TRANSFER';
    return res.status(409).json({ code, message: `Transfer '${transferId}' already exists` });
  }

  const src = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(sourceAccount);
  if (!src) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Source account not found' });
  if (src.owner_id !== req.user.user_id) return res.status(403).json({ code: 'FORBIDDEN', message: 'Not your account' });
  if (parseFloat(src.balance) < parseFloat(amount)) {
    return res.status(422).json({ code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds in source account' });
  }

  const destPrefix = destinationAccount.substring(0, 3);
  const ts = new Date().toISOString();

  // Same-bank
  if (destPrefix === getBankPrefix()) {
    const dst = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(destinationAccount);
    if (!dst) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Destination account not found' });

    let creditAmount = amount;
    let convertedAmount = null, exchangeRate = null, rateCapturedAt = null;

    if (src.currency !== dst.currency) {
      try {
        const rates = await getExchangeRates();
        const srcRate = src.currency === rates.baseCurrency ? 1 : parseFloat(rates.rates[src.currency]);
        const dstRate = dst.currency === rates.baseCurrency ? 1 : parseFloat(rates.rates[dst.currency]);
        creditAmount = ((parseFloat(amount) / srcRate) * dstRate).toFixed(2);
        convertedAmount = creditAmount;
        exchangeRate = (dstRate / srcRate).toFixed(6);
        rateCapturedAt = rates.timestamp;
      } catch (e) {
        return res.status(503).json({ code: 'EXCHANGE_RATE_UNAVAILABLE', message: 'Cannot fetch exchange rates' });
      }
    }

    db.transaction(() => {
      db.prepare('UPDATE accounts SET balance = ? WHERE account_number = ?')
        .run((parseFloat(src.balance) - parseFloat(amount)).toFixed(2), sourceAccount);
      db.prepare('UPDATE accounts SET balance = ? WHERE account_number = ?')
        .run((parseFloat(dst.balance) + parseFloat(creditAmount)).toFixed(2), destinationAccount);
      db.prepare(`INSERT INTO transfers (transfer_id,source_account,destination_account,amount,converted_amount,exchange_rate,rate_captured_at,status,created_at) VALUES (?,?,?,?,?,?,?,'completed',?)`)
        .run(transferId, sourceAccount, destinationAccount, amount, convertedAmount, exchangeRate, rateCapturedAt, ts);
    })();

    const resp = { transferId, status: 'completed', sourceAccount, destinationAccount, amount, timestamp: ts };
    if (convertedAmount) { resp.convertedAmount = convertedAmount; resp.exchangeRate = exchangeRate; resp.rateCapturedAt = rateCapturedAt; }
    return res.status(201).json(resp);
  }

  // Cross-bank
  const destBank = findBankByPrefix(destPrefix);
  if (!destBank) return res.status(404).json({ code: 'BANK_NOT_FOUND', message: `No bank with prefix '${destPrefix}'` });

  let convertedAmount = amount, exchangeRate = null, rateCapturedAt = null;

  try {
    const rates = await getExchangeRates();
    const lookupRes = await fetch(`${destBank.address}/api/v1/accounts/${destinationAccount}`);
    if (lookupRes.ok) {
      const destInfo = await lookupRes.json();
      if (src.currency !== destInfo.currency) {
        const srcRate = src.currency === rates.baseCurrency ? 1 : parseFloat(rates.rates[src.currency]);
        const dstRate = destInfo.currency === rates.baseCurrency ? 1 : parseFloat(rates.rates[destInfo.currency]);
        convertedAmount = ((parseFloat(amount) / srcRate) * dstRate).toFixed(2);
        exchangeRate = (dstRate / srcRate).toFixed(6);
        rateCapturedAt = rates.timestamp;
      }
    }
  } catch (e) {
    console.error('Rate/lookup error:', e.message);
    return res.status(503).json({ code: 'EXCHANGE_RATE_UNAVAILABLE', message: 'Cannot fetch exchange rates for cross-bank transfer' });
  }

  db.prepare('UPDATE accounts SET balance = ? WHERE account_number = ?')
    .run((parseFloat(src.balance) - parseFloat(amount)).toFixed(2), sourceAccount);

  const jwtPayload = {
    transferId, sourceAccount, destinationAccount,
    amount: convertedAmount,
    sourceBankId: getBankId(),
    destinationBankId: destBank.bankId,
    timestamp: ts,
    nonce: uuid().replace(/-/g, '').substring(0, 16)
  };

  try {
    const jwt = await signJwt(jwtPayload);
    const tfRes = await fetch(`${destBank.address}/api/v1/transfers/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt })
    });

    if (tfRes.ok) {
      db.prepare(`INSERT INTO transfers (transfer_id,source_account,destination_account,amount,converted_amount,exchange_rate,rate_captured_at,status,created_at) VALUES (?,?,?,?,?,?,?,'completed',?)`)
        .run(transferId, sourceAccount, destinationAccount, amount, convertedAmount, exchangeRate, rateCapturedAt, ts);
      const resp = { transferId, status: 'completed', sourceAccount, destinationAccount, amount, timestamp: ts };
      if (exchangeRate) { resp.convertedAmount = convertedAmount; resp.exchangeRate = exchangeRate; resp.rateCapturedAt = rateCapturedAt; }
      return res.status(201).json(resp);
    }

    const errData = await tfRes.json().catch(() => ({ message: 'Unknown error' }));
    db.prepare('UPDATE accounts SET balance = ? WHERE account_number = ?').run(src.balance, sourceAccount);
    db.prepare(`INSERT INTO transfers (transfer_id,source_account,destination_account,amount,status,error_message,created_at) VALUES (?,?,?,?,'failed',?,?)`)
      .run(transferId, sourceAccount, destinationAccount, amount, errData.message, ts);
    return res.status(422).json({ transferId, status: 'failed', sourceAccount, destinationAccount, amount, timestamp: ts, errorMessage: errData.message });
  } catch (e) {
    const pendingSince = ts;
    const nextRetryAt = new Date(Date.now() + 60000).toISOString();
    db.prepare(`INSERT INTO transfers (transfer_id,source_account,destination_account,amount,converted_amount,exchange_rate,rate_captured_at,status,pending_since,next_retry_at,retry_count,created_at) VALUES (?,?,?,?,?,?,?,'pending',?,?,0,?)`)
      .run(transferId, sourceAccount, destinationAccount, amount, convertedAmount, exchangeRate, rateCapturedAt, pendingSince, nextRetryAt, ts);
    return res.status(201).json({ transferId, status: 'pending', sourceAccount, destinationAccount, amount, timestamp: ts });
  }
});

// Receive cross-bank transfer
app.post('/api/v1/transfers/receive', async (req, res) => {
  const { jwt: token } = req.body;
  if (!token) return res.status(400).json({ code: 'INVALID_REQUEST', message: 'JWT is required' });

  try {
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const sourceBank = getBanksCache().find(b => b.bankId === payload.sourceBankId);
    if (!sourceBank) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Source bank not found' });

    const verified = await verifyJwt(token, sourceBank.publicKey);
    const dst = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(verified.destinationAccount);
    if (!dst) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Destination account not found' });

    const existing = db.prepare('SELECT 1 FROM transfers WHERE transfer_id = ?').get(verified.transferId);
    if (existing) return res.status(409).json({ code: 'DUPLICATE_TRANSFER', message: 'Transfer already processed' });

    const ts = new Date().toISOString();
    db.transaction(() => {
      const newBalance = (parseFloat(dst.balance) + parseFloat(verified.amount)).toFixed(2);
      db.prepare('UPDATE accounts SET balance = ? WHERE account_number = ?').run(newBalance, verified.destinationAccount);
      db.prepare(`INSERT INTO transfers (transfer_id,source_account,destination_account,amount,status,created_at) VALUES (?,?,?,?,'completed',?)`)
        .run(verified.transferId, verified.sourceAccount, verified.destinationAccount, verified.amount, ts);
    })();

    res.json({ transferId: verified.transferId, status: 'completed', destinationAccount: verified.destinationAccount, amount: verified.amount, timestamp: ts });
  } catch (e) {
    console.error('Receive error:', e);
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid JWT signature' });
  }
});

// Get transfer status
app.get('/api/v1/transfers/:transferId', authenticate, (req, res) => {
  const t = db.prepare('SELECT * FROM transfers WHERE transfer_id = ?').get(req.params.transferId);
  if (!t) return res.status(404).json({ code: 'TRANSFER_NOT_FOUND', message: 'Transfer not found' });

  // Check ownership: user must own source or destination account
  const userAccounts = db.prepare('SELECT account_number FROM accounts WHERE owner_id = ?').all(req.user.user_id).map(a => a.account_number);
  if (!userAccounts.includes(t.source_account) && !userAccounts.includes(t.destination_account)) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'You do not have access to this transfer' });
  }

  const resp = {
    transferId: t.transfer_id, status: t.status,
    sourceAccount: t.source_account, destinationAccount: t.destination_account,
    amount: t.amount, timestamp: t.created_at
  };
  if (t.converted_amount) resp.convertedAmount = t.converted_amount;
  if (t.exchange_rate) resp.exchangeRate = t.exchange_rate;
  if (t.rate_captured_at) resp.rateCapturedAt = t.rate_captured_at;
  if (t.pending_since) resp.pendingSince = t.pending_since;
  if (t.next_retry_at) resp.nextRetryAt = t.next_retry_at;
  if (t.retry_count != null && t.status === 'pending') resp.retryCount = t.retry_count;
  if (t.error_message) resp.errorMessage = t.error_message;
  res.json(resp);
});

// Transfer history for user
app.get('/api/v1/users/:userId/transfers', authenticate, (req, res) => {
  if (req.user.user_id !== req.params.userId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Not authorized' });
  }
  const userAccounts = db.prepare('SELECT account_number FROM accounts WHERE owner_id = ?').all(req.params.userId).map(a => a.account_number);
  if (!userAccounts.length) return res.json({ transfers: [] });

  const placeholders = userAccounts.map(() => '?').join(',');
  const transfers = db.prepare(`SELECT * FROM transfers WHERE source_account IN (${placeholders}) OR destination_account IN (${placeholders}) ORDER BY created_at DESC`).all(...userAccounts, ...userAccounts);

  res.json({
    transfers: transfers.map(t => ({
      transferId: t.transfer_id, status: t.status,
      sourceAccount: t.source_account, destinationAccount: t.destination_account,
      amount: t.amount, timestamp: t.created_at,
      ...(t.converted_amount && { convertedAmount: t.converted_amount }),
      ...(t.exchange_rate && { exchangeRate: t.exchange_rate }),
      ...(t.error_message && { errorMessage: t.error_message }),
    }))
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'transfer-service' }));

// Retry worker
function startRetryWorker() {
  setInterval(async () => {
  const pending = db.prepare(`SELECT * FROM transfers WHERE status = 'pending' AND next_retry_at <= ?`).all(new Date().toISOString());
  for (const t of pending) {
    if (Date.now() - new Date(t.pending_since).getTime() > 4 * 60 * 60 * 1000) {
      const src = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(t.source_account);
      if (src) db.prepare('UPDATE accounts SET balance = ? WHERE account_number = ?').run((parseFloat(src.balance) + parseFloat(t.amount)).toFixed(2), t.source_account);
      db.prepare(`UPDATE transfers SET status = 'failed_timeout', error_message = 'Transfer timed out after 4 hours. Funds refunded.' WHERE transfer_id = ?`).run(t.transfer_id);
      continue;
    }
    const destPrefix = t.destination_account.substring(0, 3);
    const destBank = findBankByPrefix(destPrefix);
    if (!destBank) continue;
    try {
      const jwt = await signJwt({
        transferId: t.transfer_id, sourceAccount: t.source_account, destinationAccount: t.destination_account,
        amount: t.converted_amount || t.amount, sourceBankId: getBankId(), destinationBankId: destBank.bankId,
        timestamp: t.created_at, nonce: uuid().replace(/-/g, '').substring(0, 16)
      });
      const tfRes = await fetch(`${destBank.address}/api/v1/transfers/receive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jwt })
      });
      if (tfRes.ok) db.prepare(`UPDATE transfers SET status = 'completed' WHERE transfer_id = ?`).run(t.transfer_id);
      else throw new Error('Rejected');
    } catch {
      const retryCount = t.retry_count + 1;
      const delay = Math.min(60 * 60 * 1000, Math.pow(2, retryCount) * 60 * 1000);
      db.prepare('UPDATE transfers SET retry_count = ?, next_retry_at = ? WHERE transfer_id = ?').run(retryCount, new Date(Date.now() + delay).toISOString(), t.transfer_id);
    }
  }
  }, 30000);
}

const PORT = process.env.TRANSFER_SERVICE_PORT || 3003;
app.listen(PORT, () => {
  console.log(`Transfer service on port ${PORT}`);
  startRetryWorker();
});
