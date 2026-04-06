import dotenv from 'dotenv';
import axios from 'axios';
import { Horizon, Keypair, Asset, TransactionBuilder, Operation, BASE_FEE } from '@stellar/stellar-sdk';
import { NETWORK_CONFIG } from './config.js';

dotenv.config();

// Configuración — red centralizada en config.js (MEJORA 6)
const SERVER_URL = process.env.BASE_URL || 'http://localhost:3000';
const horizon = new Horizon.Server(NETWORK_CONFIG.horizon);

const AGENT_PUBLIC_KEY = process.env.AGENT_PUBLIC_KEY;
const AGENT_SECRET_KEY = process.env.AGENT_SECRET_KEY;

const USDC_ISSUER = 'GBYB7LIBRRVDHLJ55BKUC4SYUXJMP5PSLYQONGWCOCK5NCCICYYVOU3N';

// ─────────────────────────────────────────
// Función principal: pagar y consumir servicio
// ─────────────────────────────────────────
async function payAndCall(method, endpoint, body = null) {
  console.log(`\n🤖 Agente llamando: ${method} ${endpoint}`);

  // PASO 1: Primera llamada — esperamos el 402
  try {
    const config = {
      method,
      url: SERVER_URL + endpoint,
      headers: { 'Content-Type': 'application/json' },
      ...(body && { data: body })
    };

    const firstCall = await axios(config);
    console.log('✅ Respuesta directa (sin pago):', firstCall.data);
    return firstCall.data;

  } catch (err) {
    if (err.response?.status !== 402) {
      throw new Error('Error inesperado: ' + err.message);
    }

    // PASO 2: Recibimos el 402 — leemos los detalles del pago
    const paymentInfo = err.response.data;
    console.log(`\n💳 Pago requerido:`);
    console.log(`   Precio:   ${paymentInfo.price} ${paymentInfo.asset}`);
    console.log(`   Receptor: ${paymentInfo.receiver}`);

    // PASO 3: Realizar el pago en Stellar
    console.log(`\n⏳ Realizando pago en Stellar testnet...`);
    const txHash = await makePayment(
      paymentInfo.receiver,
      paymentInfo.price,
      paymentInfo.asset
    );
    console.log(`✅ Pago confirmado! TX: ${txHash}`);
    console.log(`🔍 Ver en: ${NETWORK_CONFIG.explorerBase}/${txHash}`);

    // PASO 4: Construir header de pago
    const paymentHeader = Buffer.from(
      JSON.stringify({ txHash, from: AGENT_PUBLIC_KEY })
    ).toString('base64');

    // PASO 5: Reintentar con el comprobante de pago
    console.log(`\n🔄 Reintentando con comprobante de pago...`);
    const secondCall = await axios({
      method,
      url: SERVER_URL + endpoint,
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': paymentHeader
      },
      ...(body && { data: body })
    });

    return secondCall.data;
  }
}

// ─────────────────────────────────────────
// Función para hacer el pago en Stellar
// ─────────────────────────────────────────
async function makePayment(receiver, amount, assetCode) {
  const keypair = Keypair.fromSecret(AGENT_SECRET_KEY);
  const account = await horizon.loadAccount(AGENT_PUBLIC_KEY);

  const asset = assetCode === 'XLM'
    ? Asset.native()
    : new Asset(assetCode, USDC_ISSUER);

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG.passphrase,
  })
    .addOperation(Operation.payment({
      destination: receiver,
      asset,
      amount: amount.toString(),
    }))
    .setTimeout(30)
    .build();

  transaction.sign(keypair);

  const result = await horizon.submitTransaction(transaction);
  return result.hash;
}

// ─────────────────────────────────────────
// Función para agregar trustline de USDC
// ─────────────────────────────────────────
async function addUSDCTrustline() {
  try {
    const account = await horizon.loadAccount(AGENT_PUBLIC_KEY);
    const hasTrustline = account.balances.some(
      b => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER
    );

    if (hasTrustline) {
      console.log('✅ Trustline USDC ya existe en wallet del agente');
      return;
    }

    console.log('⏳ Agregando trustline USDC al agente...');
    const keypair = Keypair.fromSecret(AGENT_SECRET_KEY);
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_CONFIG.passphrase,
    })
      .addOperation(Operation.changeTrust({
        asset: new Asset('USDC', USDC_ISSUER),
      }))
      .setTimeout(30)
      .build();

    transaction.sign(keypair);
    await horizon.submitTransaction(transaction);
    console.log('✅ Trustline USDC agregada al agente');
  } catch (err) {
    console.error('Error agregando trustline:', err.message);
  }
}

// ─────────────────────────────────────────
// Demo: el agente corre sus tareas
// ─────────────────────────────────────────
async function runAgent() {
  console.log('═══════════════════════════════════════');
  console.log('🤖 AgentMarket — Agente Autónomo');
  console.log('═══════════════════════════════════════');
  console.log(`📬 Wallet del agente: ${AGENT_PUBLIC_KEY}`);

  // Setup inicial
  await addUSDCTrustline();

  // Mostrar servicios disponibles
  console.log('\n📋 Descubriendo servicios disponibles...');
  const catalog = await axios.get(SERVER_URL + '/services');
  console.log('Servicios encontrados:');
  catalog.data.services.forEach(s => {
    console.log(`  → ${s.name} | ${s.price} | ${s.endpoint}`);
  });

  // TAREA 1: Traducir texto
  console.log('\n─────────────────────────────────────');
  console.log('TAREA 1: Traducir texto al español');
  console.log('─────────────────────────────────────');
  const translation = await payAndCall('POST', '/services/translate', {
    text: 'Hello world, this is an autonomous agent',
    target_lang: 'es'
  });
  console.log('\n📦 Resultado:');
  console.log(`   Original:   ${translation.original}`);
  console.log(`   Traducido:  ${translation.translated}`);
  console.log(`   Pagado:     ${translation.paid}`);

  // TAREA 2: Obtener precio de BTC
  console.log('\n─────────────────────────────────────');
  console.log('TAREA 2: Consultar precio de BTC');
  console.log('─────────────────────────────────────');
  const price = await payAndCall('GET', '/services/price/BTC');
  console.log('\n📦 Resultado:');
  console.log(`   Activo:  ${price.symbol}`);
  console.log(`   Precio:  $${price.price_usd} USD`);
  console.log(`   Pagado:  ${price.paid}`);

  console.log('\n═══════════════════════════════════════');
  console.log('✅ Agente completó todas sus tareas');
  console.log('💰 Total gastado: 0.002 USDC');
  console.log('═══════════════════════════════════════');
}

runAgent().catch(console.error);