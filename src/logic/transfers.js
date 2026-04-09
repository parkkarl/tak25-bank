import db from '../db.js';
import {
  getBankPrefix, getBankId, findBankByPrefix,
  getExchangeRates, signJwt, verifyJwt, getBanksCache
} from '../services/centralBank.js';

// Atomic debit — returns true if successful
function atomicDebit(accountNumber, amount) {
  const result = db.prepare(
    "UPDATE accounts SET balance = printf('%.2f', CAST(balance AS REAL) - CAST(? AS REAL)) WHERE account_number = ? AND CAST(balance AS REAL) >= CAST(? AS REAL)"
  ).run(amount, accountNumber, amount);
  return result.changes === 1;
}

// Atomic credit
function atomicCredit(accountNumber, amount) {
  db.prepare(
    "UPDATE accounts SET balance = printf('%.2f', CAST(balance AS REAL) + CAST(? AS REAL)) WHERE account_number = ?"
  ).run(amount, accountNumber);
}

// Atomic refund (same as credit but semantically different)
function atomicRefund(accountNumber, amount) {
  atomicCredit(accountNumber, amount);
}

export function validateAmount(amount) {
  if (typeof amount !== 'string' || !/^\d+\.\d{2}$/.test(amount) || parseFloat(amount) <= 0 || !isFinite(parseFloat(amount))) {
    return 'Amount must be a positive number with 2 decimal places (e.g. "100.00")';
  }
  return null;
}

export function sameBankTransfer({ transferId, sourceAccount, destinationAccount, amount }) {
  const src = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(sourceAccount);
  const dst = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(destinationAccount);
  if (!dst) return { error: { status: 404, code: 'ACCOUNT_NOT_FOUND', message: 'Destination account not found' } };

  const ts = new Date().toISOString();
  let creditAmount = amount;
  let convertedAmount = null, exchangeRate = null, rateCapturedAt = null;

  // Must do currency conversion before transaction
  let rates = null;
  if (src.currency !== dst.currency) {
    try {
      rates = null; // Will be set inside async wrapper
    } catch (e) {
      return { error: { status: 503, code: 'EXCHANGE_RATE_UNAVAILABLE', message: 'Cannot fetch exchange rates' } };
    }
  }

  return { src, dst, ts, needsRates: src.currency !== dst.currency };
}

export async function executeSameBankTransfer({ transferId, sourceAccount, destinationAccount, amount }) {
  const dst = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(destinationAccount);
  if (!dst) return { error: { status: 404, code: 'ACCOUNT_NOT_FOUND', message: 'Destination account not found' } };

  const src = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(sourceAccount);
  const ts = new Date().toISOString();
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
      return { error: { status: 503, code: 'EXCHANGE_RATE_UNAVAILABLE', message: 'Cannot fetch exchange rates' } };
    }
  }

  try {
    db.transaction(() => {
      if (!atomicDebit(sourceAccount, amount)) {
        throw new Error('INSUFFICIENT_FUNDS');
      }
      atomicCredit(destinationAccount, creditAmount);
      db.prepare(`INSERT INTO transfers (transfer_id,source_account,destination_account,amount,converted_amount,exchange_rate,rate_captured_at,status,created_at) VALUES (?,?,?,?,?,?,?,'completed',?)`)
        .run(transferId, sourceAccount, destinationAccount, amount, convertedAmount, exchangeRate, rateCapturedAt, ts);
    })();
  } catch (e) {
    if (e.message === 'INSUFFICIENT_FUNDS') {
      return { error: { status: 422, code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds in source account' } };
    }
    throw e;
  }

  const resp = { transferId, status: 'completed', sourceAccount, destinationAccount, amount, timestamp: ts };
  if (convertedAmount) { resp.convertedAmount = convertedAmount; resp.exchangeRate = exchangeRate; resp.rateCapturedAt = rateCapturedAt; }
  return { data: resp };
}

export async function executeCrossBankTransfer({ transferId, sourceAccount, destinationAccount, amount, userId }) {
  const src = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(sourceAccount);
  const destPrefix = destinationAccount.substring(0, 3);
  const destBank = findBankByPrefix(destPrefix);
  if (!destBank) return { error: { status: 404, code: 'BANK_NOT_FOUND', message: `No bank with prefix '${destPrefix}'` } };

  const ts = new Date().toISOString();
  let convertedAmount = amount, exchangeRate = null, rateCapturedAt = null;

  try {
    const rates = await getExchangeRates();
    const lookupRes = await fetch(`${destBank.address}/accounts/${destinationAccount}`);
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
    return { error: { status: 503, code: 'EXCHANGE_RATE_UNAVAILABLE', message: 'Cannot fetch exchange rates for cross-bank transfer' } };
  }

  // Atomic debit
  if (!atomicDebit(sourceAccount, amount)) {
    return { error: { status: 422, code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds in source account' } };
  }

  const jwtPayload = {
    transferId, sourceAccount, destinationAccount,
    amount: convertedAmount,
    sourceBankId: getBankId(),
    destinationBankId: destBank.bankId,
    timestamp: ts,
    nonce: Math.random().toString(36).substring(2, 18)
  };

  try {
    const jwt = await signJwt(jwtPayload);
    const tfRes = await fetch(`${destBank.address}/transfers/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt })
    });

    if (tfRes.ok) {
      db.prepare(`INSERT INTO transfers (transfer_id,source_account,destination_account,amount,converted_amount,exchange_rate,rate_captured_at,status,created_at) VALUES (?,?,?,?,?,?,?,'completed',?)`)
        .run(transferId, sourceAccount, destinationAccount, amount, convertedAmount, exchangeRate, rateCapturedAt, ts);
      const resp = { transferId, status: 'completed', sourceAccount, destinationAccount, amount, timestamp: ts };
      if (exchangeRate) { resp.convertedAmount = convertedAmount; resp.exchangeRate = exchangeRate; resp.rateCapturedAt = rateCapturedAt; }
      return { data: resp };
    }

    // Rejected — refund
    const errData = await tfRes.json().catch(() => ({ message: 'Unknown error' }));
    atomicRefund(sourceAccount, amount);
    db.prepare(`INSERT INTO transfers (transfer_id,source_account,destination_account,amount,status,error_message,created_at) VALUES (?,?,?,?,'failed',?,?)`)
      .run(transferId, sourceAccount, destinationAccount, amount, errData.message, ts);
    return { data: { transferId, status: 'failed', sourceAccount, destinationAccount, amount, timestamp: ts, errorMessage: errData.message }, status: 422 };
  } catch (e) {
    // Destination unavailable — pending
    const pendingSince = ts;
    const nextRetryAt = new Date(Date.now() + 60000).toISOString();
    db.prepare(`INSERT INTO transfers (transfer_id,source_account,destination_account,amount,converted_amount,exchange_rate,rate_captured_at,status,pending_since,next_retry_at,retry_count,created_at) VALUES (?,?,?,?,?,?,?,'pending',?,?,0,?)`)
      .run(transferId, sourceAccount, destinationAccount, amount, convertedAmount, exchangeRate, rateCapturedAt, pendingSince, nextRetryAt, ts);
    return { data: { transferId, status: 'pending', sourceAccount, destinationAccount, amount, timestamp: ts } };
  }
}

export async function receiveTransfer(token) {
  if (!token) return { error: { status: 400, code: 'INVALID_REQUEST', message: 'JWT is required' } };

  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const sourceBank = getBanksCache().find(b => b.bankId === payload.sourceBankId);
  if (!sourceBank) return { error: { status: 401, code: 'UNAUTHORIZED', message: 'Source bank not found' } };

  const verified = await verifyJwt(token, sourceBank.publicKey);
  const dst = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(verified.destinationAccount);
  if (!dst) return { error: { status: 404, code: 'ACCOUNT_NOT_FOUND', message: 'Destination account not found' } };

  const existing = db.prepare('SELECT 1 FROM transfers WHERE transfer_id = ?').get(verified.transferId);
  if (existing) return { error: { status: 409, code: 'DUPLICATE_TRANSFER', message: 'Transfer already processed' } };

  const ts = new Date().toISOString();
  db.transaction(() => {
    atomicCredit(verified.destinationAccount, verified.amount);
    db.prepare(`INSERT INTO transfers (transfer_id,source_account,destination_account,amount,status,created_at) VALUES (?,?,?,?,'completed',?)`)
      .run(verified.transferId, verified.sourceAccount, verified.destinationAccount, verified.amount, ts);
  })();

  return { data: { transferId: verified.transferId, status: 'completed', destinationAccount: verified.destinationAccount, amount: verified.amount, timestamp: ts } };
}

export function getTransferStatus(transferId, userId) {
  const t = db.prepare('SELECT * FROM transfers WHERE transfer_id = ?').get(transferId);
  if (!t) return { error: { status: 404, code: 'TRANSFER_NOT_FOUND', message: 'Transfer not found' } };

  const userAccounts = db.prepare('SELECT account_number FROM accounts WHERE owner_id = ?').all(userId).map(a => a.account_number);
  if (!userAccounts.includes(t.source_account) && !userAccounts.includes(t.destination_account)) {
    return { error: { status: 403, code: 'FORBIDDEN', message: 'You do not have access to this transfer' } };
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
  return { data: resp };
}

export function getUserTransfers(userId) {
  const userAccounts = db.prepare('SELECT account_number FROM accounts WHERE owner_id = ?').all(userId).map(a => a.account_number);
  if (!userAccounts.length) return { data: { transfers: [] } };

  const placeholders = userAccounts.map(() => '?').join(',');
  const transfers = db.prepare(`SELECT * FROM transfers WHERE source_account IN (${placeholders}) OR destination_account IN (${placeholders}) ORDER BY created_at DESC`).all(...userAccounts, ...userAccounts);

  return {
    data: {
      transfers: transfers.map(t => ({
        transferId: t.transfer_id, status: t.status,
        sourceAccount: t.source_account, destinationAccount: t.destination_account,
        amount: t.amount, timestamp: t.created_at,
        ...(t.converted_amount && { convertedAmount: t.converted_amount }),
        ...(t.exchange_rate && { exchangeRate: t.exchange_rate }),
        ...(t.error_message && { errorMessage: t.error_message }),
      }))
    }
  };
}

// Retry worker logic
export async function retryPendingTransfers() {
  const pending = db.prepare(`SELECT * FROM transfers WHERE status = 'pending' AND next_retry_at <= ?`).all(new Date().toISOString());
  for (const t of pending) {
    if (Date.now() - new Date(t.pending_since).getTime() > 4 * 60 * 60 * 1000) {
      atomicRefund(t.source_account, t.amount);
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
        timestamp: t.created_at, nonce: Math.random().toString(36).substring(2, 18)
      });
      const tfRes = await fetch(`${destBank.address}/transfers/receive`, {
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
}
