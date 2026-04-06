/**
 * fund-agent.js
 *
 * Crea un issuer USDC propio en Stellar testnet (estándar para desarrollo),
 * acuña USDC a Provider y Agent, y actualiza USDC_ISSUER en .env.
 *
 * Por qué issuer propio: el issuer de Circle (GA5ZS...) es de mainnet.
 * En testnet existe pero nadie tiene su secret key para acuñar.
 * Usar un issuer propio es la práctica recomendada para demos en testnet.
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import axios from 'axios';
import {
  Horizon, Keypair, Asset,
  TransactionBuilder, Networks,
  Operation, BASE_FEE
} from '@stellar/stellar-sdk';

const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const NETWORK = Networks.TESTNET;

async function friendbot(publicKey) {
  await axios.get(`https://friendbot.stellar.org/?addr=${publicKey}`, { timeout: 15000 });
}

async function loadAccount(pub) {
  return horizon.loadAccount(pub);
}

async function submit(tx) {
  return horizon.submitTransaction(tx);
}

async function getUSDCBalance(publicKey, issuer) {
  const acc = await loadAccount(publicKey);
  const b = acc.balances.find(x => x.asset_code === 'USDC' && x.asset_issuer === issuer);
  return b ? b.balance : '0.0000000';
}

// ── 1. Crear issuer USDC de testnet ──────────────────────────────────────────
async function createTestnetIssuer() {
  const envPath = new URL('.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  let envContent = fs.readFileSync(envPath, 'utf8');

  // Si ya hay un issuer testnet propio, reutilizarlo
  const existingMatch = envContent.match(/^USDC_ISSUER_SECRET=(.+)$/m);
  if (existingMatch) {
    const issuerKeypair = Keypair.fromSecret(existingMatch[1].trim());
    console.log('♻️  Reutilizando issuer testnet existente:', issuerKeypair.publicKey());
    return issuerKeypair;
  }

  console.log('⏳ Creando nuevo issuer USDC para testnet...');
  const issuerKeypair = Keypair.random();
  console.log('   Issuer public: ', issuerKeypair.publicKey());

  console.log('⏳ Fondeando issuer via Friendbot...');
  await friendbot(issuerKeypair.publicKey());
  console.log('✅ Issuer fondeado con XLM');

  // Guardar en .env
  envContent = envContent.replace(/^USDC_ISSUER=.+$/m, `USDC_ISSUER=${issuerKeypair.publicKey()}`);
  if (!envContent.match(/^USDC_ISSUER=/m)) {
    envContent += `\nUSDC_ISSUER=${issuerKeypair.publicKey()}`;
  }
  if (!envContent.match(/^USDC_ISSUER_SECRET=/m)) {
    envContent += `\nUSDC_ISSUER_SECRET=${issuerKeypair.secret()}`;
  }
  fs.writeFileSync(envPath, envContent);
  console.log('✅ USDC_ISSUER y USDC_ISSUER_SECRET guardados en .env');

  return issuerKeypair;
}

// ── 2. Agregar trustline ──────────────────────────────────────────────────────
async function ensureTrustline(publicKey, secretKey, usdc, label) {
  const acc = await loadAccount(publicKey);
  const has = acc.balances.some(
    b => b.asset_code === 'USDC' && b.asset_issuer === usdc.issuer
  );
  if (has) {
    console.log(`✅ ${label} ya tiene trustline USDC`);
    return;
  }
  console.log(`⏳ Agregando trustline USDC a ${label}...`);
  const kp  = Keypair.fromSecret(secretKey);
  const tx  = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  await submit(tx);
  console.log(`✅ Trustline USDC agregada a ${label}`);
}

// ── 3. Acuñar USDC (issuer → wallet) ─────────────────────────────────────────
async function mint(issuerKeypair, destination, amount, label) {
  const usdc = new Asset('USDC', issuerKeypair.publicKey());
  console.log(`⏳ Acuñando ${amount} USDC → ${label}...`);
  const acc = await loadAccount(issuerKeypair.publicKey());
  const tx  = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.payment({ destination, asset: usdc, amount }))
    .setTimeout(30)
    .build();
  tx.sign(issuerKeypair);
  const result = await submit(tx);
  console.log(`✅ ${amount} USDC acuñados a ${label}`);
  console.log(`   TX: https://stellar.expert/explorer/testnet/tx/${result.hash}`);
  return result.hash;
}

// ── 4. Actualizar USDC_ISSUER en los archivos fuente ─────────────────────────
function updateSourceFiles(newIssuer) {
  const files = ['server.js', 'client.js', 'setup.js'];
  const oldIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  for (const file of files) {
    const path = new URL(file, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    if (!fs.existsSync(path)) continue;
    const original = fs.readFileSync(path, 'utf8');
    const updated  = original.replaceAll(oldIssuer, newIssuer);
    if (original !== updated) {
      fs.writeFileSync(path, updated);
      console.log(`✅ ${file} actualizado con nuevo USDC_ISSUER`);
    } else {
      console.log(`ℹ️  ${file} ya usa el issuer correcto`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const providerPublic = process.env.PROVIDER_PUBLIC_KEY;
  const providerSecret = process.env.PROVIDER_SECRET_KEY;
  const agentPublic    = process.env.AGENT_PUBLIC_KEY;
  const agentSecret    = process.env.AGENT_SECRET_KEY;

  console.log('═══════════════════════════════════════');
  console.log('  fund-agent.js — Setup USDC testnet');
  console.log('═══════════════════════════════════════');
  console.log('Provider:', providerPublic);
  console.log('Agent:   ', agentPublic);

  // 1. Issuer
  console.log('\n── Paso 1: Issuer USDC testnet ─────────');
  const issuerKP = await createTestnetIssuer();
  const USDC     = new Asset('USDC', issuerKP.publicKey());

  // 2. Trustlines
  console.log('\n── Paso 2: Trustlines ──────────────────');
  await ensureTrustline(providerPublic, providerSecret, USDC, 'Provider');
  await ensureTrustline(agentPublic,    agentSecret,    USDC, 'Agent');

  // 3. Acuñar
  console.log('\n── Paso 3: Acuñar USDC ─────────────────');
  await mint(issuerKP, agentPublic,    '10', 'Agent');
  await mint(issuerKP, providerPublic, '10', 'Provider');

  // 4. Actualizar issuer en archivos
  console.log('\n── Paso 4: Actualizar archivos fuente ──');
  updateSourceFiles(issuerKP.publicKey());

  // 5. Resumen
  const agentBal    = await getUSDCBalance(agentPublic,    issuerKP.publicKey());
  const providerBal = await getUSDCBalance(providerPublic, issuerKP.publicKey());

  console.log(`
═══════════════════════════════════════
✅ Setup completado!
   USDC Issuer: ${issuerKP.publicKey()}
   Agent saldo:    ${agentBal} USDC
   Provider saldo: ${providerBal} USDC

🚀 Siguiente paso: node client.js
═══════════════════════════════════════`);
}

main().catch(err => {
  const codes = err.response?.data?.extras?.result_codes;
  console.error('Error:', codes ? JSON.stringify(codes) : err.message);
  process.exit(1);
});
