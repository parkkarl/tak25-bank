import { describe, it, before } from 'node:test';
import assert from 'node:assert';

const API = 'http://localhost:3000/api/v1';
let apiKey, userId, accountNumber, apiKey2, userId2, accountNumber2;

async function api(method, path, body, key) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (key) opts.headers.Authorization = `Bearer ${key}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  return { status: res.status, data: await res.json() };
}

const unique = () => `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

describe('Users', () => {
  it('should register a user', async () => {
    const { status, data } = await api('POST', '/users', { fullName: 'Test User' });
    assert.strictEqual(status, 201);
    assert.ok(data.userId.startsWith('user-'));
    assert.ok(data.apiKey);
    apiKey = data.apiKey;
    userId = data.userId;
  });

  it('should reject duplicate email', async () => {
    const email = `${unique()}@test.com`;
    await api('POST', '/users', { fullName: 'Alice', email });
    const { status, data } = await api('POST', '/users', { fullName: 'Bob', email });
    assert.strictEqual(status, 409);
    assert.strictEqual(data.code, 'DUPLICATE_USER');
  });

  it('should reject empty name', async () => {
    const { status } = await api('POST', '/users', { fullName: '' });
    assert.strictEqual(status, 400);
  });

  it('should get user profile with auth', async () => {
    const { status, data } = await api('GET', `/users/${userId}`, null, apiKey);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.fullName, 'Test User');
  });

  it('should reject profile without auth', async () => {
    const { status } = await api('GET', `/users/${userId}`);
    assert.strictEqual(status, 401);
  });

  it('should reject viewing other user profile', async () => {
    const u2 = await api('POST', '/users', { fullName: 'Other' });
    const { status, data } = await api('GET', `/users/${u2.data.userId}`, null, apiKey);
    assert.strictEqual(status, 403);
  });

  it('should get current user via /me', async () => {
    const { status, data } = await api('GET', '/me', null, apiKey);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.userId, userId);
  });
});

describe('Accounts', () => {
  it('should create EUR account', async () => {
    const { status, data } = await api('POST', `/users/${userId}/accounts`, { currency: 'EUR' }, apiKey);
    assert.strictEqual(status, 201);
    assert.strictEqual(data.currency, 'EUR');
    assert.strictEqual(data.balance, '0.00');
    assert.strictEqual(data.accountNumber.length, 8);
    accountNumber = data.accountNumber;
  });

  it('should reject without auth', async () => {
    const { status } = await api('POST', `/users/${userId}/accounts`, { currency: 'EUR' });
    assert.strictEqual(status, 401);
  });

  it('should reject invalid currency format', async () => {
    const { status } = await api('POST', `/users/${userId}/accounts`, { currency: 'euro' }, apiKey);
    assert.strictEqual(status, 400);
  });

  it('should lookup account without auth', async () => {
    const { status, data } = await api('GET', `/accounts/${accountNumber}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.ownerName, 'Test User');
    assert.strictEqual(data.currency, 'EUR');
  });

  it('should return 404 for unknown account', async () => {
    const { status, data } = await api('GET', '/accounts/XXX00000');
    assert.strictEqual(status, 404);
    assert.strictEqual(data.code, 'ACCOUNT_NOT_FOUND');
  });

  it('should list user accounts', async () => {
    const { status, data } = await api('GET', `/users/${userId}/accounts`, null, apiKey);
    assert.strictEqual(status, 200);
    assert.ok(data.accounts.length >= 1);
  });
});

describe('Transfers', () => {
  before(async () => {
    const u2 = await api('POST', '/users', { fullName: 'User Two' });
    apiKey2 = u2.data.apiKey;
    userId2 = u2.data.userId;
    const a2 = await api('POST', `/users/${userId2}/accounts`, { currency: 'EUR' }, apiKey2);
    accountNumber2 = a2.data.accountNumber;
  });

  it('should reject negative amount', async () => {
    const { status, data } = await api('POST', '/transfers', {
      transferId: crypto.randomUUID(), sourceAccount: accountNumber, destinationAccount: accountNumber2, amount: '-10.00'
    }, apiKey);
    assert.strictEqual(status, 400);
    assert.strictEqual(data.code, 'INVALID_REQUEST');
  });

  it('should reject bad amount format', async () => {
    const { status } = await api('POST', '/transfers', {
      transferId: crypto.randomUUID(), sourceAccount: accountNumber, destinationAccount: accountNumber2, amount: '100'
    }, apiKey);
    assert.strictEqual(status, 400);
  });

  it('should reject insufficient funds', async () => {
    const { status, data } = await api('POST', '/transfers', {
      transferId: crypto.randomUUID(), sourceAccount: accountNumber, destinationAccount: accountNumber2, amount: '1000.00'
    }, apiKey);
    assert.strictEqual(status, 422);
    assert.strictEqual(data.code, 'INSUFFICIENT_FUNDS');
  });

  it('should reject transfer from other user account', async () => {
    const { status, data } = await api('POST', '/transfers', {
      transferId: crypto.randomUUID(), sourceAccount: accountNumber, destinationAccount: accountNumber2, amount: '1.00'
    }, apiKey2);
    assert.strictEqual(status, 403);
    assert.strictEqual(data.code, 'FORBIDDEN');
  });

  it('should reject missing fields', async () => {
    const { status } = await api('POST', '/transfers', { sourceAccount: accountNumber }, apiKey);
    assert.strictEqual(status, 400);
  });

  it('should reject transfer without auth', async () => {
    const { status } = await api('POST', '/transfers', {
      transferId: crypto.randomUUID(), sourceAccount: accountNumber, destinationAccount: accountNumber2, amount: '1.00'
    });
    assert.strictEqual(status, 401);
  });
});

describe('Health', () => {
  it('should return ok', async () => {
    const res = await fetch('http://localhost:3000/health');
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
  });
});
