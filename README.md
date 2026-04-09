# TAK25 Bank - Harukontori API

Panga harukontori API, mis suudab registreerida kasutajaid, hallata kontosid, teha pangasiseseid ja pankadevahelisi ülekandeid ning suhelda Keskpangaga.

## Kasutatud tehnoloogiad

- **Node.js** - runtime
- **Express** - web framework
- **SQLite** (better-sqlite3) - andmebaas
- **jose** - ES256 JWT allkirjastamine pankadevahelistes ülekannetes
- **swagger-ui-express** - API dokumentatsioon
- **uuid** - unikaalsete identifikaatorite genereerimine

## Mikroteenuste arhitektuur

```
                    +-----------------------+
                    |   API Gateway (:3000) |
                    |   - Swagger UI /docs  |
                    |   - Keskpanga integ.  |
                    |   - Heartbeat         |
                    +---+-------+-------+---+
                        |       |       |
              +---------+  +----+----+  +----------+
              |            |         |             |
    +---------v--+  +------v----+  +-v-----------+ |
    | User Svc   |  | Account   |  | Transfer    | |
    | (:3001)    |  | Svc(:3002)|  | Svc (:3003) | |
    +-----+------+  +-----+----+  +------+------+ |
          |               |              |         |
          +-------+-------+-------+------+         |
                  |                                 |
           +------v------+              +----------v---------+
           | SQLite DB   |              | Keskpank (external) |
           | bank.db     |              | test.diarainfra.com |
           +-------------+              +--------------------+
```

- **API Gateway** - marsruutimine, Swagger UI, keskpanga integratsioon
- **User Service** - kasutajate registreerimine ja autentimine
- **Account Service** - kontode haldus ja otsing
- **Transfer Service** - ülekanded, retry worker, JWT verifitseerimine

## Andmebaasi skeem

### users
| Veerg | Tüüp | Kirjeldus |
|-------|-------|-----------|
| user_id | TEXT PK | `user-{UUID}` |
| full_name | TEXT NOT NULL | Kasutaja täisnimi |
| email | TEXT UNIQUE | Valikuline e-post |
| api_key | TEXT UNIQUE | Bearer token autentimiseks |
| created_at | TEXT | ISO 8601 ajatempel |

### accounts
| Veerg | Tüüp | Kirjeldus |
|-------|-------|-----------|
| account_number | TEXT PK | 8 tähemärki: `{BANK_PREFIX}{5-SUFFIX}` |
| owner_id | TEXT FK | Viide users.user_id |
| currency | TEXT | ISO 4217 valuutakood |
| balance | TEXT | Saldo stringina (täpsuse jaoks) |
| created_at | TEXT | ISO 8601 ajatempel |

### transfers
| Veerg | Tüüp | Kirjeldus |
|-------|-------|-----------|
| transfer_id | TEXT PK | UUID idempotentsuse jaoks |
| source_account | TEXT | Lähteonto |
| destination_account | TEXT | Sihtkonto |
| amount | TEXT | Summa lähtevaluutas |
| converted_amount | TEXT | Summa sihtvaluutas |
| exchange_rate | TEXT | Vahetuskurss |
| status | TEXT | completed/pending/failed/failed_timeout |
| retry_count | INTEGER | Korduskatsete arv |
| created_at | TEXT | ISO 8601 ajatempel |

### bank_config
| Veerg | Tüüp | Kirjeldus |
|-------|-------|-----------|
| key | TEXT PK | Seadistuse nimi |
| value | TEXT | Seadistuse väärtus |

## Installatsioon ja käivitamine

```bash
# Klooni repo
git clone <repo-url>
cd bank

# Installi sõltuvused
npm install

# Käivita (mikroteenused)
npm start

# Või käivita monoliidina
npm run start:monolith
```

Keskkonnamuutujad:
- `PORT` - Gateway port (vaikimisi 3000)
- `BANK_NAME` - Panga nimi (vaikimisi "TAK25 Bank")
- `BANK_ADDRESS` - Panga avalik URL (vaikimisi http://localhost:PORT)
- `CENTRAL_BANK_URL` - Keskpanga API URL

## Swagger UI

Käivita server ja ava brauseris:
```
http://localhost:3000/docs/
```

## API endpointid

| Endpoint | Meetod | Auth | Kirjeldus |
|----------|--------|------|-----------|
| `/api/v1/users` | POST | Ei | Kasutaja registreerimine |
| `/api/v1/users/{userId}` | GET | Ei | Kasutaja info + kontod |
| `/api/v1/users/{userId}/accounts` | POST | Jah | Konto loomine |
| `/api/v1/users/{userId}/accounts` | GET | Jah | Kasutaja kontod saldodega |
| `/api/v1/accounts/{accountNumber}` | GET | Ei | Konto otsing (omaniku nimi) |
| `/api/v1/transfers` | POST | Jah | Ülekanne |
| `/api/v1/transfers/{transferId}` | GET | Jah | Ülekande staatus |
| `/api/v1/users/{userId}/transfers` | GET | Jah | Ülekannete ajalugu |
| `/api/v1/transfers/receive` | POST | JWT | Laekumine teisest pangast |

## Näidispäringud

### Registreeri kasutaja
```bash
curl -X POST http://localhost:3000/api/v1/users \
  -H "Content-Type: application/json" \
  -d '{"fullName": "Jaan Tamm", "email": "jaan@test.com"}'
```

### Loo konto
```bash
curl -X POST http://localhost:3000/api/v1/users/{userId}/accounts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {apiKey}" \
  -d '{"currency": "EUR"}'
```

### Vaata saldot
```bash
curl http://localhost:3000/api/v1/users/{userId}/accounts \
  -H "Authorization: Bearer {apiKey}"
```

### Tee ülekanne
```bash
curl -X POST http://localhost:3000/api/v1/transfers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {apiKey}" \
  -d '{
    "transferId": "550e8400-e29b-41d4-a716-446655440000",
    "sourceAccount": "HTT12345",
    "destinationAccount": "HTT54321",
    "amount": "100.00"
  }'
```

### Vaata ülekannete ajalugu
```bash
curl http://localhost:3000/api/v1/users/{userId}/transfers \
  -H "Authorization: Bearer {apiKey}"
```
