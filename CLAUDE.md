# TAK25 Bank - Harukontori API

## Projekt

Panga harukontori API mikroteenuste arhitektuuriga. Suhtleb Keskpangaga ja teiste pankadega.

- **Keel:** Node.js (ESM), Express, SQLite (better-sqlite3)
- **JWT:** ES256 (jose) pankadevaheliste ülekannete allkirjastamiseks
- **Docs:** Swagger UI (`/docs/`)
- **Keskpanga API:** https://test.diarainfra.com/central-bank/

## Käivitamine

```bash
npm install
npm start              # Mikroteenused (4 protsessi: gateway:3000, user:3001, account:3002, transfer:3003)
npm run start:monolith # Monoliit (1 protsess, port 3000) — kasutatakse serveris
```

## Struktuur

```
src/                        # Monoliidi kood (kasutatakse ka serveris)
  index.js                  # Express server + Swagger UI + keskpanga init
  db.js                     # SQLite andmebaas (bank.db, WAL mode)
  middleware/auth.js        # Bearer token autentimine
  routes/users.js           # POST /users, GET /users/:id
  routes/accounts.js        # POST /users/:id/accounts, GET /accounts/:nr, GET /users/:id/accounts
  routes/transfers.js       # POST /transfers, POST /transfers/receive, GET /transfers/:id, GET /users/:id/transfers
  services/centralBank.js   # Keskpanga integratsioon (registreerimine, heartbeat, kursid, JWT)
  openapi.yaml              # OpenAPI 3.1.0 spetsifikatsioon

services/                   # Mikroteenuste eraldi protsessid
  gateway.js                # API Gateway (port 3000) — proxy + Swagger UI
  user-service.js           # Port 3001
  account-service.js        # Port 3002
  transfer-service.js       # Port 3003

start.js                    # Mikroteenuste orkestreeija (fork + auto-restart)
```

## Andmebaas

SQLite (`bank.db`), 4 tabelit:
- `users` — user_id (PK), full_name, email, api_key, created_at
- `accounts` — account_number (PK, 8 tähemärki: prefix+5), owner_id (FK), currency, balance, created_at
- `bank_config` — key/value (bankId, bankPrefix, privateKey, publicKey)
- `transfers` — transfer_id (PK, UUID), source/dest account, amount, status, retry info

## API endpointid

| Endpoint | Meetod | Auth | Kirjeldus |
|----------|--------|------|-----------|
| `/api/v1/users` | POST | Ei | Kasutaja registreerimine (tagastab apiKey) |
| `/api/v1/users/:id` | GET | Jah | Kasutaja profiil + kontod |
| `/api/v1/users/:id/accounts` | POST | Jah | Konto loomine |
| `/api/v1/users/:id/accounts` | GET | Jah | Kasutaja kontod saldodega |
| `/api/v1/accounts/:nr` | GET | Ei | Konto otsing (omaniku nimi + valuuta) |
| `/api/v1/transfers` | POST | Jah | Ülekanne (pangasisene/pankadevaheline) |
| `/api/v1/transfers/:id` | GET | Jah | Ülekande staatus (ainult omanik) |
| `/api/v1/users/:id/transfers` | GET | Jah | Ülekannete ajalugu |
| `/api/v1/transfers/receive` | POST | JWT | Laekumine teisest pangast |
| `/health` | GET | Ei | Tervisekontroll |
| `/docs/` | GET | Ei | Swagger UI |

## Production server (Hetzner)

### Ühenduse andmed

- **IP:** 89.167.83.242
- **User:** root
- **SSH:** `ssh root@89.167.83.242`
- **Repo serveris:** `/opt/tak25-bank/`
- **Andmebaas:** `/opt/tak25-bank/bank.db`
- **Systemd teenus:** `tak25-bank`

### Live URL-id

| Ressurss | URL |
|----------|-----|
| API | http://89.167.83.242:3000/api/v1/ |
| Swagger UI | http://89.167.83.242:3000/docs/ |
| Health | http://89.167.83.242:3000/health |

### Keskpanga info

- **Bank ID:** TAK001
- **Prefiks:** TAK (kontonumbrid algavad TAK-ga)
- **Heartbeat:** iga 25 min automaatselt

### Deploy

```bash
# Tavaline deploy (pull + restart):
ssh root@89.167.83.242 "cd /opt/tak25-bank && git pull && npm install && systemctl restart tak25-bank"

# Ainult restart (ilma koodi muutmata):
ssh root@89.167.83.242 "systemctl restart tak25-bank"

# Teenuse staatus:
ssh root@89.167.83.242 "systemctl status tak25-bank"

# Logid (viimased 50 rida):
ssh root@89.167.83.242 "journalctl -u tak25-bank --no-pager -n 50"

# Logid (reaalajas):
ssh root@89.167.83.242 "journalctl -u tak25-bank -f"

# Teenuse peatamine:
ssh root@89.167.83.242 "systemctl stop tak25-bank"
```

### Systemd teenuse konfiguratsioon

Fail: `/etc/systemd/system/tak25-bank.service`

```ini
[Unit]
Description=TAK25 Bank API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/tak25-bank
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=BANK_NAME=TAK25 Bank
Environment=BANK_ADDRESS=http://89.167.83.242:3000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Pärast muutmist: `ssh root@89.167.83.242 "systemctl daemon-reload && systemctl restart tak25-bank"`

### Post-deploy kontroll

```bash
# Health check:
curl -s http://89.167.83.242:3000/health

# Keskpangas registreeritud:
curl -s https://test.diarainfra.com/central-bank/api/v1/banks | jq '.banks[] | select(.bankId == "TAK001")'

# Logid OK:
ssh root@89.167.83.242 "journalctl -u tak25-bank --no-pager -n 5"
```

### Andmebaasi debug

```bash
# Vaata kasutajaid:
ssh root@89.167.83.242 "sqlite3 /opt/tak25-bank/bank.db 'SELECT user_id, full_name FROM users'"

# Vaata kontosid:
ssh root@89.167.83.242 "sqlite3 /opt/tak25-bank/bank.db 'SELECT account_number, currency, balance FROM accounts'"

# Vaata ülekandeid:
ssh root@89.167.83.242 "sqlite3 /opt/tak25-bank/bank.db 'SELECT transfer_id, status, amount FROM transfers'"

# Vaata panga konfiguratsiooni:
ssh root@89.167.83.242 "sqlite3 /opt/tak25-bank/bank.db 'SELECT key, value FROM bank_config WHERE key != \"privateKey\"'"
```

## GitHub

**Repo:** https://github.com/parkkarl/tak25-bank

```bash
git push                # Push muudatused GitHubi
# Seejärel deploy serverisse:
ssh root@89.167.83.242 "cd /opt/tak25-bank && git pull && npm install && systemctl restart tak25-bank"
```
