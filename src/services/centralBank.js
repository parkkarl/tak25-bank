import * as jose from 'jose';
import db from '../db.js';

const CB_URL = process.env.CENTRAL_BANK_URL || 'https://test.diarainfra.com/central-bank/api/v1';

let bankId = null;
let bankPrefix = null;
let privateKey = null;
let publicKeyPem = null;
let banksCache = [];

export function getBankPrefix() {
  if (bankPrefix) return bankPrefix;
  const row = db.prepare("SELECT value FROM bank_config WHERE key = 'bankPrefix'").get();
  return row ? row.value : 'BNK';
}
export function getBankId() {
  if (bankId) return bankId;
  const row = db.prepare("SELECT value FROM bank_config WHERE key = 'bankId'").get();
  return row ? row.value : null;
}
export const getBanksCache = () => banksCache;

// Central bank returns PHP warnings before JSON — strip them
function extractJson(text) {
  const idx = text.indexOf('{');
  return idx >= 0 ? JSON.parse(text.substring(idx)) : JSON.parse(text);
}

export async function init(name, address) {
  // Try to reuse existing keypair from DB (so central bank's public key stays valid after restart)
  const existingKey = db.prepare("SELECT value FROM bank_config WHERE key = 'privateKey'").get();
  const existingPub = db.prepare("SELECT value FROM bank_config WHERE key = 'publicKey'").get();

  if (existingKey && existingPub) {
    privateKey = await jose.importPKCS8(existingKey.value, 'ES256');
    publicKeyPem = existingPub.value;
    console.log('Reusing existing keypair from database');
  } else {
    const { publicKey: pub, privateKey: priv } = await jose.generateKeyPair('ES256');
    privateKey = priv;
    publicKeyPem = await jose.exportSPKI(pub);
    console.log('Generated new ES256 keypair');
  }

  const res = await fetch(`${CB_URL}/banks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, address, publicKey: publicKeyPem })
  });

  const text = await res.text();

  if (res.status === 409) {
    // Already registered — find our bankId from bank directory
    console.log('Bank address already registered, looking up existing bankId...');
    const listRes = await fetch(`${CB_URL}/banks`);
    if (listRes.ok) {
      const listData = await listRes.json();
      const existing = (listData.banks || []).find(b => b.address === address);
      if (existing) {
        bankId = existing.bankId;
        bankPrefix = bankId.substring(0, 3);
        // Check if central bank has our current public key
        if (existing.publicKey !== publicKeyPem) {
          console.log('Public key mismatch — waiting for old registration to expire...');
          console.log('Inter-bank transfers may not work until re-registration completes.');
        }
        console.log(`Found existing registration: ${bankId}`);
      }
    }
    if (!bankId) throw new Error('Bank address registered but could not find bankId');
  } else if (!res.ok) {
    const err = extractJson(text);
    throw new Error(`Registration failed: ${err.message}`);
  } else {
    const data = extractJson(text);
    bankId = data.bankId;
    bankPrefix = bankId.substring(0, 3);
  }

  // Persist keypair and config
  db.prepare("INSERT OR REPLACE INTO bank_config (key, value) VALUES ('bankId', ?)").run(bankId);
  db.prepare("INSERT OR REPLACE INTO bank_config (key, value) VALUES ('bankPrefix', ?)").run(bankPrefix);
  db.prepare("INSERT OR REPLACE INTO bank_config (key, value) VALUES ('privateKey', ?)").run(await jose.exportPKCS8(privateKey));
  db.prepare("INSERT OR REPLACE INTO bank_config (key, value) VALUES ('publicKey', ?)").run(publicKeyPem);

  console.log(`Registered as ${bankId} (prefix: ${bankPrefix})`);

  await syncBanks();

  // Send heartbeat immediately, then every 5 minutes
  async function sendHeartbeat() {
    try {
      await fetch(`${CB_URL}/banks/${bankId}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: new Date().toISOString() })
      });
      await syncBanks();
      console.log('Heartbeat sent');
    } catch (e) { console.error('Heartbeat error:', e.message); }
  }
  await sendHeartbeat();
  setInterval(sendHeartbeat, 5 * 60 * 1000);

  return { bankId, bankPrefix };
}

export async function syncBanks() {
  try {
    const res = await fetch(`${CB_URL}/banks`);
    if (res.ok) {
      const data = await res.json();
      banksCache = data.banks || [];
    }
  } catch (e) { console.error('Sync error:', e.message); }
}

export async function getExchangeRates() {
  const res = await fetch(`${CB_URL}/exchange-rates`);
  if (!res.ok) throw new Error('Failed to fetch exchange rates');
  return res.json();
}

export function findBankByPrefix(prefix) {
  return banksCache.find(b => b.bankId.startsWith(prefix));
}

export async function signJwt(payload) {
  let key = privateKey;
  if (!key) {
    const row = db.prepare("SELECT value FROM bank_config WHERE key = 'privateKey'").get();
    if (row) key = await jose.importPKCS8(row.value, 'ES256');
  }
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

export async function verifyJwt(token, pem) {
  const key = await jose.importSPKI(pem, 'ES256');
  const { payload } = await jose.jwtVerify(token, key);
  return payload;
}
