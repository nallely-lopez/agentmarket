import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { readFileSync } from 'fs';
import { Horizon, Keypair, Asset, TransactionBuilder, Networks, Operation, BASE_FEE } from '@stellar/stellar-sdk';

const DEMO_HTML = new URL('./demo.html', import.meta.url);

dotenv.config();

// MEJORA 2: BASE_URL configurable por variable de entorno (evita hardcodear localhost)
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

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
  'GBYB7LIBRRVDHLJ55BKUC4SYUXJMP5PSLYQONGWCOCK5NCCICYYVOU3N'
);

const SERVICE_PRICE = '0.001'; // USDC por servicio

// MEJORA 3: Set global para protección contra replay attacks.
// En producción esto debe persistirse en base de datos (Redis, Postgres, etc.)
// para sobrevivir reinicios del servidor.
const usedTxHashes = new Set();

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

    if (!paymentOp) return false;

    // MEJORA 3: Protección contra replay attacks — rechaza txHash ya usado
    if (usedTxHashes.has(txHash)) {
      console.warn('Replay attack detectado — txHash ya usado:', txHash);
      return false;
    }
    usedTxHashes.add(txHash);

    return true;
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
      usdc_issuer: 'GBYB7LIBRRVDHLJ55BKUC4SYUXJMP5PSLYQONGWCOCK5NCCICYYVOU3N',
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
// MEJORA 1: /ping — evita cold start en Render
// ─────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date() });
});

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

  // MEJORA 5: Diccionario de fallback si MyMemory falla
  const fallbackTranslations = {
    es: {
      'hello': 'hola', 'world': 'mundo', 'agent': 'agente',
      'payment': 'pago', 'market': 'mercado',
      'how are you': 'cómo estás', 'good morning': 'buenos días',
    },
    en: {
      'hola': 'hello', 'mundo': 'world', 'agente': 'agent',
      'pago': 'payment', 'mercado': 'market',
    },
    fr: {
      'hello': 'bonjour', 'world': 'monde',
      'agent': 'agent', 'payment': 'paiement',
    }
  };

  try {
    // MEJORA 5: Traducción real con MyMemory API (no requiere API key)
    const myMemoryUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${target_lang}`;
    let translated;
    let source = 'MyMemory API';

    try {
      const apiResp = await axios.get(myMemoryUrl, { timeout: 5000 });
      const match = apiResp.data?.responseData?.translatedText;
      if (match && apiResp.data?.responseStatus === 200) {
        translated = match;
      } else {
        throw new Error('Respuesta inválida de MyMemory');
      }
    } catch (apiErr) {
      // Fallback al diccionario si la API falla
      console.warn('MyMemory falló, usando diccionario fallback:', apiErr.message);
      const dict = fallbackTranslations[target_lang] || fallbackTranslations['es'];
      translated = text.toLowerCase();
      for (const [key, val] of Object.entries(dict)) {
        translated = translated.replace(new RegExp(key, 'gi'), val);
      }
      source = 'fallback dictionary';
    }

    res.json({
      success: true,
      original: text,
      translated,
      target_lang,
      source,
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
// Función de pago usada por /demo/run
// ─────────────────────────────────────────
async function makeAgentPayment(receiver, amount, assetCode, issuer) {
  const agentPublic = process.env.AGENT_PUBLIC_KEY;
  const agentSecret = process.env.AGENT_SECRET_KEY;
  const keypair = Keypair.fromSecret(agentSecret);
  const account = await server.loadAccount(agentPublic);
  const asset   = assetCode === 'XLM' ? Asset.native() : new Asset(assetCode, issuer);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.payment({ destination: receiver, asset, amount }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

// ─────────────────────────────────────────
// GET /demo — sirve la página de demo
// ─────────────────────────────────────────
app.get('/demo', (req, res) => {
  res.type('html').send(readFileSync(DEMO_HTML));
});

// ─────────────────────────────────────────
// POST /demo/run — ejecuta flujo x402 completo
//   body: { service: 'translate' | 'price' }
//   responde con SSE (text/event-stream)
// ─────────────────────────────────────────
app.post('/demo/run', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (step, payload = {}) =>
    res.write(`data: ${JSON.stringify({ step, ...payload })}\n\n`);

  const { service = 'translate' } = req.body;
  const BASE = BASE_URL;

  const endpoint = service === 'translate'
    ? { method: 'POST', url: BASE + '/services/translate',
        data: { text: 'Hello world, this is an autonomous agent', target_lang: 'es' } }
    : { method: 'GET',  url: BASE + '/services/price/BTC' };

  try {
    // Paso 1 — primera llamada, esperamos 402
    send('calling', { message: `Llamando al servicio: ${endpoint.method} ${endpoint.url}` });

    let paymentInfo;
    try {
      await axios({ method: endpoint.method, url: endpoint.url, data: endpoint.data });
    } catch (err) {
      if (err.response?.status !== 402) throw err;
      paymentInfo = err.response.data;
      send('payment_required', {
        message: `402 recibido — pagando ${paymentInfo.price} ${paymentInfo.asset} en Stellar...`,
        price:    paymentInfo.price,
        asset:    paymentInfo.asset,
        receiver: paymentInfo.receiver,
      });
    }

    // Paso 2 — realizar pago en Stellar
    send('paying', { message: 'Firmando y enviando transacción Stellar...' });
    const txHash = await makeAgentPayment(
      paymentInfo.receiver,
      paymentInfo.price,
      paymentInfo.asset,
      paymentInfo.usdc_issuer
    );
    send('payment_confirmed', {
      message: `Pago confirmado TX: ${txHash}`,
      txHash,
    });

    // Paso 3 — reintentar con comprobante
    const paymentHeader = Buffer.from(
      JSON.stringify({ txHash, from: process.env.AGENT_PUBLIC_KEY })
    ).toString('base64');

    const result = await axios({
      method:  endpoint.method,
      url:     endpoint.url,
      data:    endpoint.data,
      headers: { 'X-Payment': paymentHeader },
    });

    send('done', { message: 'Servicio entregado', data: result.data });

  } catch (err) {
    send('error', { message: err.response?.data?.error || err.message });
  }

  res.end();
});

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