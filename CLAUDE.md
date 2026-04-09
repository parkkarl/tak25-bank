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
Environment=BANK_ADDRESS=http://89.167.83.242:3000/api/v1
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

## TÄHTIS: Ära kunagi kustuta bank.db!

DB sisaldab ES256 võtmepaari mis on keskpangas registreeritud. Kustutamine = uus võti = keskpanga public key mismatch = pankadevahelised ülekanded ei tööta kuni vana registreering aegub (30 min).

## Ülesande juhend

### Pangaülesanne — Grupp TAK25

**Eesmärk:** Disainida ja implementeerida täielik panga harukontori API, mis suudab registreerida kasutajaid, hallata kontosid, teha pangasiseseid ja pankadevahelisi ülekandeid ning suhelda Keskpangaga.

- **Keskpanga API:** https://test.diarainfra.com/central-bank/
- **Harukontori OpenAPI spetsifikatsioon:** https://test.diarainfra.com/central-bank/openapi/branch-bank.yaml

### Arhitektuurinõuded

Mikroteenuste arhitektuur:
- Rakendus jagatud väikesteks, ülesandepõhisteks komponentideks
- Iga teenus iseseisvalt deployeritav ja skaleeritav
- Teenused suhtlevad standardiseeritud viisil (REST API)
- Iga teenus valitseb oma andmete ja loogika üle

### Funktsionaalsed nõuded

1. **Kasutajahaldus** — registreerimine, info küsimine, autentimine API võtmetega
2. **Kontohaldus** — konto loomine, info küsimine, saldo jälgimine
3. **Ülekanded** — pangasisesed, pankadevahelised, ajaloo küsimine, oleku jälgimine, laekumiste vastuvõtmine
4. **Keskpanga integratsioon** — registreerimine, heartbeat (30 min timeout), pankade loend + vahemälu, vahetuskursid, ES256 JWT
5. **Swagger UI** — kõik endpointid nähtavad ja testitavad, live-keskkonnas kättesaadav

### Tehnilised nõuded

- Sobiv andmebaas tabelite ja struktuuridega, transaktsioonid
- Kõik endpointid vastavalt openapi/branch-bank.yaml
- JSON päringud/vastused, korrektsed HTTP staatuskoodid
- Bearer token autentimine, kasutajaõiguste kontroll
- Privaat- ja avaliku võtme genereerimine JWT allkirjastamiseks
- Veakäsitlus sobivate staatuskoodide ja veateadetega
- Idempotentsus transferId-ga

### Keskpanga endpointid

- `POST /api/v1/banks` — registreerimine
- `GET /api/v1/banks` — pankade loend (lastSyncedAt vahemälu jaoks)
- `GET /api/v1/banks/{bankId}` — konkreetse panga andmed
- `POST /api/v1/banks/{bankId}/heartbeat` — südamelöök
- `GET /api/v1/exchange-rates` — vahetuskursid (EUR baasvaluuta)

### Hindamiskriteeriumid

- [ ] API täielikkus — kõik endpointid töötavad
- [ ] Mikroteenuste arhitektuur — sobiv ja efektiivne
- [ ] Andmebaasi disain — sobiv ja efektiivne
- [ ] Autentimine ja autoriseerimine — turvaline ja töötab
- [ ] Ülekannete töötlus — korrektne ja usaldusväärne
- [ ] Keskpanga integratsioon — suhtleb edukalt
- [ ] Veakäsitlus — täielik ja informatiivne
- [ ] Koodikvaliteet — loetav ja võimekas
- [ ] Dokumentatsioon — arusaadav ja täielik
- [ ] Swagger UI olemasolu ja toimivus
- [ ] Testimine — korduvate stsenaariumide katmine
- [ ] Live URL töötab ja on kättesaadav

### Esitamine

GitHub repo README.md peab sisaldama:
- Kasutatud tehnoloogiad
- Mikroteenuste arhitektuuri kirjeldus
- Andmebaasi skeem
- Kuidas API-d käivitada
- Live URL
- Swagger UI URL
- Näidispäringud
- Testide tulemused
