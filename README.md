# AgentMarket — AI Agent Marketplace on Stellar

[![Node.js](https://img.shields.io/badge/Node.js-22.x-green)](https://nodejs.org)
[![Stellar](https://img.shields.io/badge/Stellar-Testnet-blue)](https://stellar.org)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![Live Demo](https://img.shields.io/badge/Demo-Live-brightgreen)](https://agentmarket-21w2.onrender.com/demo)
[![Soroban](https://img.shields.io/badge/Soroban-Contract-blue)](https://stellar.expert/explorer/testnet/contract/CC3XGTB67SCDXNV5QQUKECXR5JSQL354MVEZUFKYCEX22VRNSXBXSQHH)

> A marketplace where AI agents autonomously discover, pay for, and consume services using x402 protocol and USDC micropayments on Stellar.

**Live Demo:** https://agentmarket-21w2.onrender.com/demo  
**GitHub:** https://github.com/nallely-lopez/agentmarket

---

## El problema / The Problem

Today, when an AI agent needs to use another agent's service (translate text, get market data, run analysis), it has no native way to pay for that service without human intervention. Traditional APIs use monthly subscriptions or shared API keys — they are not designed for machine-to-machine payments.

AgentMarket implements the **x402 protocol** over HTTP, enabling agents to autonomously discover services, pay per request in USDC, and receive results — all in under 5 seconds, with every transaction verifiable on-chain.

---

## Demo en vivo / Live Demo

Visit: **https://agentmarket-21w2.onrender.com/demo**

> Note: The server runs on Render's free tier and may take up to 50 seconds to wake up after inactivity (cold start). Please wait if the page loads slowly.

The demo shows the complete x402 flow in real time:
1. Agent calls a service
2. Receives HTTP 402 Payment Required with price
3. Automatically pays 0.001 USDC on Stellar testnet
4. Retries with payment proof header
5. Receives the result

Every transaction is verifiable on: https://stellar.expert/explorer/testnet

---

## Arquitectura / Architecture

┌─────────────────┐         HTTP x402 Protocol          ┌─────────────────┐
│   AI Agent      │                                      │  AgentMarket    │
│   (client.js)   │──── 1. GET /services/translate ────▶│  Server         │
│                 │◀─── 2. 402 + price: 0.001 USDC ─────│  (server.js)    │
│   Stellar       │                                      │                 │
│   Wallet        │──── 3. Signs & submits TX ─────────▶│  Stellar        │
│   (USDC)        │         on Stellar testnet           │  Testnet        │
│                 │                                      │                 │
│                 │──── 4. Retry + X-Payment header ───▶│                 │
│                 │◀─── 5. 200 OK + result ──────────────│                 │
└─────────────────┘                                      └─────────────────┘

### x402 Flow

The x402 protocol embeds payments directly in HTTP:

1. **First request** — Agent calls the endpoint normally
2. **402 Response** — Server returns `HTTP 402 Payment Required` with payment details (price, receiver address, asset)
3. **Payment** — Agent builds, signs and submits a Stellar transaction paying the required USDC amount
4. **Retry** — Agent re-sends the request with an `X-Payment` header containing base64-encoded proof `{txHash, from}`
5. **Verification** — Server verifies the transaction on Horizon (Stellar's API), confirms payment went to the right address with the right amount
6. **Service delivery** — Server executes the service and returns the result

---

## Stack tecnológico / Tech Stack

| Component | Technology |
|-----------|-----------|
| Server | Node.js 22 + Express |
| Blockchain | Stellar Testnet |
| Stablecoin | USDC (custom testnet issuer) |
| Payment Protocol | x402 (manual implementation) |
| Stellar SDK | @stellar/stellar-sdk v13 |
| HTTP Client | axios |
| Deploy | Render.com (free tier) |

---

## Instalación local / Local Setup

### Prerequisites

- Node.js v18 or higher
- A Stellar testnet account with XLM and USDC

### Steps
```bash
# 1. Clone the repository
git clone https://github.com/nallely-lopez/agentmarket.git
cd agentmarket

# 2. Install dependencies
npm install

# 3. Create your .env file
cp .env.example .env
# Edit .env with your keys (see section below)

# 4. Run setup to verify wallets and trustlines
node setup.js

# 5. Start the server
node server.js

# 6. In a separate terminal, run the agent
node client.js
```

---

## Variables de entorno / Environment Variables

Create a `.env` file in the root directory with the following variables:
```bash
# Provider wallet — receives payments for services
PROVIDER_PUBLIC_KEY=G...        # Stellar public key (starts with G)
PROVIDER_SECRET_KEY=S...        # Stellar secret key (starts with S) — NEVER share this

# Agent wallet — pays for services autonomously
AGENT_PUBLIC_KEY=G...           # Stellar public key (starts with G)
AGENT_SECRET_KEY=S...           # Stellar secret key (starts with S) — NEVER share this

# USDC issuer for testnet
USDC_ISSUER=G...                # Public key of the USDC issuer account
USDC_ISSUER_SECRET=S...         # Secret key of the USDC issuer — needed to mint tokens

# Network config
NETWORK=testnet
PORT=3000
```

### How to create testnet wallets

1. Go to https://laboratory.stellar.org
2. Generate a keypair for the **provider** and another for the **agent**
3. Fund both with XLM using Friendbot: `https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY`
4. Get testnet USDC from: https://faucet.circle.com (select Stellar Testnet)
5. Run `node setup.js` to verify trustlines and balances

---

## Servicios disponibles / Available Services

### GET /services
Free endpoint — returns the service catalog.
```json
{
  "marketplace": "AgentMarket",
  "network": "Stellar Testnet",
  "services": [
    { "id": "translate",  "endpoint": "POST /services/translate",       "price": "0.001 USDC" },
    { "id": "price",      "endpoint": "GET /services/price/:symbol",    "price": "0.001 USDC" },
    { "id": "sentiment",  "endpoint": "POST /services/sentiment",       "price": "0.002 USDC" }
  ]
}
```

### POST /services/translate
Requires payment of 0.001 USDC. Calls MyMemory API for real translation (dictionary fallback).
```json
// Request body
{ "text": "Hello world", "target_lang": "es" }

// Response
{ "success": true, "original": "Hello world", "translated": "hola mundo", "source": "MyMemory API", "paid": "0.001 USDC" }
```

### GET /services/price/:symbol
Requires payment of 0.001 USDC. Supported symbols: `BTC`, `ETH`, `XLM`, `USDC`.
```json
// Response
{ "success": true, "symbol": "BTC", "price_usd": 85000, "paid": "0.001 USDC" }
```

### POST /services/sentiment
Requires payment of 0.002 USDC. Analyzes sentiment in English and Spanish.
```json
// Request body
{ "text": "This is an amazing and wonderful product!" }

// Response
{
  "success": true, "sentiment": "positive", "score": 0.1538,
  "positive_words": ["amazing", "wonderful"],
  "negative_words": [],
  "paid": "0.002 USDC", "service": "AgentMarket Sentiment"
}
```

### GET /reputation/:service_id
Free endpoint — queries on-chain reputation score from Soroban contract.
```json
// Response
{ "service_id": "translate", "score": 1000, "total_payments": 1,
  "contract_id": "CC3XGTB67SCDXNV5QQUKECXR5JSQL354MVEZUFKYCEX22VRNSXBXSQHH", "network": "testnet" }
```

### GET /demo
Returns the interactive demo UI (HTML page).

---

## Soroban Smart Contract

Every successful payment is recorded on-chain in a Soroban smart contract deployed on Stellar Testnet. This builds a verifiable, tamper-proof reputation score for each service.

**Contract ID:** `CC3XGTB67SCDXNV5QQUKECXR5JSQL354MVEZUFKYCEX22VRNSXBXSQHH`  
**Explorer:** https://stellar.expert/explorer/testnet/contract/CC3XGTB67SCDXNV5QQUKECXR5JSQL354MVEZUFKYCEX22VRNSXBXSQHH

| Function | Description |
|----------|-------------|
| `record_payment(service_id, buyer, amount)` | Accumulates reputation score for a service |
| `get_score(service_id)` | Returns the accumulated score (i128) |
| `get_total_payments()` | Returns total payments recorded (u32) |

The contract uses **persistent storage** so scores survive ledger expiry. On-chain calls are fire-and-forget — contract failures never interrupt service delivery.

---

## Security

AgentMarket implements four layers of payment security:

| Protection | Implementation |
|------------|---------------|
| **Replay attack prevention** | `usedTxHashes` Set rejects any txHash seen before |
| **Timestamp validation** | Transactions older than 5 minutes are rejected |
| **Amount verification** | Payment must meet or exceed the service price |
| **Receiver verification** | Payment must go to the provider's exact public key |

> Note: `usedTxHashes` is in-memory. For production, persist it in Redis or PostgreSQL. See `MAINNET_CHECKLIST.md`.

---

## Limitaciones y datos simulados / Limitations & Simulated Data

**Transparency is important. Here is an honest description of what is real and what is simulated:**

### Datos simulados / Simulated data

- **Translation service** — The translator uses a simple hardcoded dictionary (hello→hola, world→mundo, etc.), not a real translation API like DeepL or LibreTranslate. A production version would integrate a real translation API behind the x402 payment.

- **USDC issuer** — The USDC used in this demo is issued by a custom keypair we created for testnet purposes, not the official Circle USDC issuer (`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`). This is because the official Circle issuer controls minting and requires their faucet, which had availability issues during development. The payment flow is identical — only the issuer differs.

- **Price service fallback** — The price service calls CoinGecko's free API. If CoinGecko rate-limits the request, it falls back to hardcoded prices (BTC: $85,000, ETH: $2,000, etc.).

### Funciones no terminadas / Unfinished features

- **Soroban reputation contract** — ✅ Deployed. Contract `CC3XGTB67SCDXNV5QQUKECXR5JSQL354MVEZUFKYCEX22VRNSXBXSQHH` records every payment on-chain and exposes `GET /reputation/:service_id`. In-memory `usedTxHashes` needs Redis/PostgreSQL persistence for production (see `MAINNET_CHECKLIST.md`).

- **Replay attack protection** — ✅ Implemented. `usedTxHashes` Set rejects duplicate txHashes. Production gap: the Set resets on server restart. Use Redis or a database for persistent protection.

- **x402/express package** — The package `@x402/express` was planned for use but is not available at the expected version on npm. The x402 middleware is implemented manually in `server.js`. The implementation follows the x402 specification but is not the official library.

- **Agent authentication** — Any client that submits a valid payment can consume a service. There is no agent identity system or access control beyond payment verification.

### Infraestructura / Infrastructure

- **Cold starts** — The app runs on Render's free tier. After 15 minutes of inactivity the server spins down. The first request after inactivity may take 50+ seconds.

---

## Roadmap

- [x] Real translation via MyMemory API (dictionary fallback)
- [x] Deploy Soroban reputation contract on testnet
- [x] Replay attack protection (txHash deduplication)
- [x] Transaction timestamp validation (5-minute window)
- [x] Sentiment analysis service
- [ ] Persist txHash cache in Redis/PostgreSQL for crash-safe replay protection
- [ ] Add agent identity system using Stellar keypairs as identities
- [ ] Integrate MPP SDK (Stellar Machine Payment Protocol) for streaming payments
- [ ] Add more services: web scraping, image generation, data analysis
- [ ] Deploy to Stellar mainnet with real USDC (see `MAINNET_CHECKLIST.md`)
- [ ] Build a service registration UI for providers

---

## Protocolo x402 / About x402

x402 is a payment protocol that embeds micropayments directly into HTTP using the long-reserved `402 Payment Required` status code. It was designed for the agentic economy — machines paying machines without human intervention.

- **Specification:** https://www.x402.org
- **Coinbase docs:** https://docs.cdp.coinbase.com/x402/docs/welcome
- **Stellar x402 docs:** https://developers.stellar.org/docs/build/apps/x402
- **Official facilitator:** https://github.com/stellar/x402-stellar

---

## Contribuciones / Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change.
```bash
# Fork the repo, then:
git checkout -b feature/your-feature
git commit -m "feat: your feature description"
git push origin feature/your-feature
# Open a Pull Request
```

---

## Licencia / License

MIT © 2026 — Built for the Stellar Hackathon "Agents on Stellar"
