import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { readFileSync } from 'fs';
import { Horizon, Keypair, Asset, TransactionBuilder, Operation, BASE_FEE,
         Contract, rpc as SorobanRpc, nativeToScVal, scValToNative, Address } from '@stellar/stellar-sdk';
import { NETWORK_CONFIG } from './config.js';

const DEMO_HTML = new URL('./demo.html', import.meta.url);

dotenv.config();

// MEJORA 2: BASE_URL configurable por variable de entorno (evita hardcodear localhost)
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const app = express();
app.use(express.json());

// Configuración — red centralizada en config.js (MEJORA 6)
const server = new Horizon.Server(NETWORK_CONFIG.horizon);

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
// Soroban RPC — cliente para el contrato de reputación
// ─────────────────────────────────────────
const SOROBAN_RPC_URL = NETWORK_CONFIG.isMainnet
  ? 'https://soroban-mainnet.stellar.org'
  : 'https://soroban-testnet.stellar.org';

const sorobanRpc = new SorobanRpc.Server(SOROBAN_RPC_URL);

// Registra un pago en el contrato de reputación on-chain.
// Falla silenciosamente: si el contrato falla, el servicio igual se entrega.
async function invokeReputationContract(serviceId, buyerAddress, amount) {
  const contractId = process.env.REPUTATION_CONTRACT_ID;
  if (!contractId) return;

  try {
    const keypair  = Keypair.fromSecret(process.env.PROVIDER_SECRET_KEY);
    const account  = await sorobanRpc.getAccount(keypair.publicKey());
    const contract = new Contract(contractId);

    const tx = new TransactionBuilder(account, {
      fee: '1000000', // fee generosa para simulación Soroban
      networkPassphrase: NETWORK_CONFIG.passphrase,
    })
      .addOperation(
        contract.call(
          'record_payment',
          nativeToScVal(serviceId, { type: 'symbol' }),
          new Address(buyerAddress).toScVal(),
          nativeToScVal(amount, { type: 'i128' }),
        )
      )
      .setTimeout(30)
      .build();

    // Simular primero (Soroban requiere prep de la transacción)
    const preparedTx = await sorobanRpc.prepareTransaction(tx);
    preparedTx.sign(keypair);
    const result = await sorobanRpc.sendTransaction(preparedTx);
    console.log(`Reputación registrada on-chain — serviceId=${serviceId} status=${result.status}`);
  } catch (err) {
    console.error('invokeReputationContract falló (no crítico):', err.message);
  }
}

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

    // Devuelve el address del pagador para que el middleware pueda registrar reputación
    return { valid: true, buyer: from };
  } catch (err) {
    console.error('Error verificando pago:', err.message);
    return { valid: false };
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
  verifyPayment(paymentHeader).then(({ valid, buyer }) => {
    if (!valid) {
      return res.status(402).json({ error: 'Pago inválido o no encontrado' });
    }
    // Registrar reputación on-chain (async, no bloquea la respuesta)
    const serviceId = req.path.replace('/services/', '').split('/')[0];
    const amountStroops = Math.round(parseFloat(SERVICE_PRICE) * 1e7);
    invokeReputationContract(serviceId, buyer, amountStroops).catch(() => {});
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

// ─────────────────────────────────────────
// PASO 6: GET /reputation/:service_id — consulta score on-chain
// ─────────────────────────────────────────
app.get('/reputation/:service_id', async (req, res) => {
  const contractId = process.env.REPUTATION_CONTRACT_ID;
  if (!contractId) {
    return res.status(503).json({ error: 'Contrato de reputación no configurado' });
  }

  const { service_id } = req.params;

  try {
    const contract = new Contract(contractId);
    const keypair  = Keypair.fromSecret(process.env.PROVIDER_SECRET_KEY);
    const account  = await sorobanRpc.getAccount(keypair.publicKey());

    const buildQuery = (method, ...args) =>
      new TransactionBuilder(account, {
        fee: '1000000',
        networkPassphrase: NETWORK_CONFIG.passphrase,
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

    // Simular get_score
    const scoreTx   = buildQuery('get_score', nativeToScVal(service_id, { type: 'symbol' }));
    const scoreRes  = await sorobanRpc.simulateTransaction(scoreTx);

    // Simular get_total_payments
    const totalTx   = buildQuery('get_total_payments');
    const totalRes  = await sorobanRpc.simulateTransaction(totalTx);

    const score = SorobanRpc.Api.isSimulationSuccess(scoreRes) && scoreRes.result?.retval
      ? Number(scValToNative(scoreRes.result.retval))
      : 0;
    const total = SorobanRpc.Api.isSimulationSuccess(totalRes) && totalRes.result?.retval
      ? Number(scValToNative(totalRes.result.retval))
      : 0;

    res.json({
      service_id,
      score:          Number(score),
      total_payments: Number(total),
      contract_id:    contractId,
      network:        NETWORK_CONFIG.isMainnet ? 'mainnet' : 'testnet',
    });
  } catch (err) {
    res.status(500).json({ error: 'Error consultando reputación: ' + err.message });
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
    networkPassphrase: NETWORK_CONFIG.passphrase,
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
    // MEJORA 7: Consultar saldo USDC del agente antes del flujo
    const agentPublic = process.env.AGENT_PUBLIC_KEY;
    const agentAccount = await server.loadAccount(agentPublic);
    const usdcBalance = agentAccount.balances.find(
      b => b.asset_code === 'USDC' && b.asset_issuer === USDC_ASSET.getIssuer()
    );
    const balance = usdcBalance ? parseFloat(usdcBalance.balance) : 0;
    send('balance', { message: `Saldo del agente: ${balance.toFixed(4)} USDC` });

    if (balance < 0.01) {
      send('error', { message: 'Saldo insuficiente. El agente necesita USDC.' });
      res.end();
      return;
    }

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
      explorerUrl: `${NETWORK_CONFIG.explorerBase}/${txHash}`,
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

    // PASO 7: Emitir score de reputación actualizado (best-effort, no bloquea)
    const contractId = process.env.REPUTATION_CONTRACT_ID;
    if (contractId) {
      try {
        const serviceSlug = service === 'translate' ? 'translate' : 'price';
        const repResp = await axios.get(`${BASE_URL}/reputation/${serviceSlug}`, { timeout: 8000 });
        send('reputation', {
          message: `Reputación actualizada on-chain — score: ${repResp.data.score}`,
          score:       repResp.data.score,
          total:       repResp.data.total_payments,
          contract_id: contractId,
          contractUrl: `https://stellar.expert/explorer/${NETWORK_CONFIG.isMainnet ? 'public' : 'testnet'}/contract/${contractId}`,
        });
      } catch (_) { /* silencioso */ }
    }

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