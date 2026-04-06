import { Networks } from '@stellar/stellar-sdk';

const isMainnet = process.env.NETWORK === 'mainnet';

export const NETWORK_CONFIG = {
  passphrase: isMainnet ? Networks.PUBLIC : Networks.TESTNET,
  horizon: isMainnet
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org',
  isMainnet,
  explorerBase: isMainnet
    ? 'https://stellar.expert/explorer/public/tx'
    : 'https://stellar.expert/explorer/testnet/tx'
};
