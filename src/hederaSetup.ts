/**
 * One-time setup for the Hedera rail: create the HCS topic that will hold verification
 * receipts, and print the details you need to check it yourself on HashScan.
 *
 *   npm run hedera:setup
 *
 * Reads HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY from .env (never committed).
 * Safe to re-run: the topic id is cached in .hedera-state.json and reused.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { loadEnv } from './loadEnv.js';

loadEnv();

const { HEDERA, ensureTopic } = await import('./hederaRail.js');

if (!HEDERA.operatorKey) {
  console.error('HEDERA_PRIVATE_KEY is not set — copy .env.example to .env and fill it in.');
  process.exit(1);
}

console.log('Hedera rail setup');
console.log('  network   :', HEDERA.network, `(EVM chainId ${HEDERA.evmChainId})`);
console.log('  operator  :', HEDERA.operatorId);
console.log('  price     :', HEDERA.priceTinybars, 'tinybars =', HEDERA.priceTinybars / 1e8, 'HBAR');

const balance = await fetch(`${HEDERA.mirror}/api/v1/accounts/${HEDERA.operatorId}`)
  .then((r) => r.json())
  .then((d: any) => d?.balance?.balance ?? 0)
  .catch(() => 0);
console.log('  balance   :', balance / 1e8, 'HBAR');

const topicId = await ensureTopic();
console.log('\nHCS receipt topic:', topicId);
console.log('  verify at :', `${HEDERA.explorer}/topic/${topicId}`);
console.log('\nNext:  npm run hedera:demo   (pays on testnet, then reads the receipt back)');
