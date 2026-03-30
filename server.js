import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { Horizon, Keypair, Asset, TransactionBuilder, Networks, Operation, BASE_FEE } from '@stellar/stellar-sdk';

dotenv.config();

const app = express();
app.use(express.json());

// Configuración
const NETWORK_PASSPHRASE = Networks.TESTNET;
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const server = new Horizon.Server(HORIZON_URL);

const PROVIDER_PUBLIC_KEY = process.env.PROVIDER_PUBLIC_KEY;
const PROVIDER_SECRET_KEY = process.env.PROVIDER_SECRET_KEY;

// USDC en Stellar testnet
const USDC_ASSET = new Asset(
  'USDC',
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
);

const SERVICE_PRICE = '0.001'; // USDC por servicio

// ─────────────────────────────────────────
// Función para verificar pago x402
// ─────────────────────────────────────────
async function verifyPayment(paymentHeader) {
  try {
    if (!paymentHeader) return false;

    const { txHash, from } = JSON.parse(
      Buffer.from(paymentHeader, 'base64').toString('utf8')
    );

    // Verificar la transacción en Horizon
    const tx = await server.transactions().transaction(txHash).call();
    
    // Verificar que la transacción es reciente (menos de 5 minutos)
    const txTime = new Date(tx.created_at).getTime();
    const now = Date.now();
    if (now - txTime > 5 * 60 * 1000) return false;

    // Verificar operaciones de pago
    const ops = await server.operations().forTransaction(txHash).call();
    const paymentOp = ops.records.find(op =>
      op.type === 'payment' &&
      op.to === PROVIDER_PUBLIC_KEY &&
      op.asset_code === 'USDC' &&
      parseFloat(op.amount) >= parseFloat(SERVICE_PRICE)
    );

    return !!paymentOp;
  } catch (err) {
    console.error('Error verificando pago:', err.message);
    return false;
  }
}

// ─────────────────────────────────────────
// Middleware x402 — exige pago antes de servir
// ─────────────────────────────────────────
function x402Middleware(req, res, next) {
  const paymentHeader = req.headers['x-payment'];

  if (!paymentHeader) {
    return res.status(402).json({
      error: 'Payment Required',
      price: SERVICE_PRICE,
      asset: 'USDC',
      network: 'testnet',
      receiver: PROVIDER_PUBLIC_KEY,
      usdc_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      instructions: 'Envía ' + SERVICE_PRICE + ' USDC a ' + PROVIDER_PUBLIC_KEY + ' y reenvía con header X-Payment: <base64({"txHash":"...","from":"..."})>'
    });
  }

  // Si hay header de pago, verificamos
  verifyPayment(paymentHeader).then(valid => {
    if (!valid) {
      return res.status(402).json({ error: 'Pago inválido o no encontrado' });
    }
    next();
  });
}

// ─────────────────────────────────────────
// SERVICIO 1: Catálogo (gratis)
// ─────────────────────────────────────────
app.get('/services', (req, res) => {
  res.json({
    marketplace: 'AgentMarket',
    network: 'Stellar Testnet',
    receiver: PROVIDER_PUBLIC_KEY,
    services: [
      {
        id: 'translate',
        name: 'Traductor de texto',
        endpoint: 'POST /services/translate',
        price: SERVICE_PRICE + ' USDC',
        body: { text: 'string', target_lang: 'string (es/en/fr)' }
      },
      {
        id: 'price',
        name: 'Precio de criptoactivo',
        endpoint: 'GET /services/price/:symbol',
        price: SERVICE_PRICE + ' USDC',
        params: { symbol: 'BTC | ETH | XLM | USDC' }
      }
    ]
  });
});

// ─────────────────────────────────────────
// SERVICIO 2: Traducción (requiere pago)
// ─────────────────────────────────────────
app.post('/services/translate', x402Middleware, async (req, res) => {
  const { text, target_lang = 'es' } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Falta el campo text' });
  }

  try {
    // Simulación de traducción (sin API key necesaria)
    const translations = {
      es: {
        'hello': 'hola',
        'world': 'mundo',
        'agent': 'agente',
        'payment': 'pago',
        'market': 'mercado',
        'how are you': 'cómo estás',
        'good morning': 'buenos días',
      },
      en: {
        'hola': 'hello',
        'mundo': 'world',
        'agente': 'agent',
        'pago': 'payment',
        'mercado': 'market',
      },
      fr: {
        'hello': 'bonjour',
        'world': 'monde',
        'agent': 'agent',
        'payment': 'paiement',
      }
    };

    const dict = translations[target_lang] || translations['es'];
    let translated = text.toLowerCase();
    for (const [key, val] of Object.entries(dict)) {
      translated = translated.replace(new RegExp(key, 'gi'), val);
    }

    res.json({
      success: true,
      original: text,
      translated,
      target_lang,
      paid: SERVICE_PRICE + ' USDC',
      service: 'AgentMarket Translator'
    });

  } catch (err) {
    res.status(500).json({ error: 'Error en traducción: ' + err.message });
  }
});

// ─────────────────────────────────────────
// SERVICIO 3: Precio de activo (requiere pago)
// ─────────────────────────────────────────
app.get('/services/price/:symbol', x402Middleware, async (req, res) => {
  const { symbol } = req.params;

  try {
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${getCoinId(symbol)}&vs_currencies=usd`,
      { timeout: 5000 }
    );

    const coinId = getCoinId(symbol);
    const price = response.data[coinId]?.usd;

    if (!price) {
      return res.status(404).json({ error: 'Símbolo no encontrado: ' + symbol });
    }

    res.json({
      success: true,
      symbol: symbol.toUpperCase(),
      price_usd: price,
      timestamp: new Date().toISOString(),
      paid: SERVICE_PRICE + ' USDC',
      service: 'AgentMarket Price Feed'
    });

  } catch (err) {
    // Fallback con precio simulado si CoinGecko falla
    const fallbackPrices = { BTC: 85000, ETH: 2000, XLM: 0.35, USDC: 1.00 };
    const price = fallbackPrices[symbol.toUpperCase()];
    
    if (price) {
      res.json({
        success: true,
        symbol: symbol.toUpperCase(),
        price_usd: price,
        timestamp: new Date().toISOString(),
        note: 'precio simulado (fallback)',
        paid: SERVICE_PRICE + ' USDC',
      });
    } else {
      res.status(500).json({ error: 'Error obteniendo precio: ' + err.message });
    }
  }
});

function getCoinId(symbol) {
  const map = {
    BTC: 'bitcoin', ETH: 'ethereum',
    XLM: 'stellar', USDC: 'usd-coin',
    SOL: 'solana', ADA: 'cardano'
  };
  return map[symbol.toUpperCase()] || symbol.toLowerCase();
}

// ─────────────────────────────────────────
// Arrancar servidor
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
🚀 AgentMarket corriendo en http://localhost:${PORT}
📋 Servicios disponibles en http://localhost:${PORT}/services
💰 Precio por servicio: ${SERVICE_PRICE} USDC
🌐 Red: Stellar Testnet
📬 Receptor de pagos: ${PROVIDER_PUBLIC_KEY}
  `);
});