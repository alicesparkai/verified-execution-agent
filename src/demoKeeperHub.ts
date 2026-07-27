/**
 * demoKeeperHub.ts — «последняя миля» целиком, БЕЗ заглушек.
 *
 * Это тот прогон, который снимается на видео для подачи (KeeperHub Agents Onchain):
 * агент приносит намерение → VEA-гейт выносит вердикт → PASS исполняется РЕАЛЬНО через
 * KeeperHub → чек подписывается Ed25519 и проверяется офлайн.
 *
 * Почему не переиспользован demoTrader.ts: там исполнение ИМИТИРОВАНО (он держит свои ключи
 * и делает mock-execution). Условие конкурса — «working transactions, NOT mockups». Здесь
 * исполнитель настоящий: инвокер шлёт вызов в живой MCP KeeperHub через tools/kh_mcp.py.
 *
 * ЧТО ПОКАЗЫВАЕТ ПРОГОН (в этом порядке — он же порядок кадров видео):
 *   1. ОПАСНОЕ намерение (безлимитный approve) → гейт BLOCK → исполнения НЕТ.
 *      Это важнее успеха: агент, который只 умеет «да», не фаервол.
 *   2. БЕЗОПАСНОЕ намерение → гейт PASS → KeeperHub подписывает и вещает → хеш транзакции.
 *   3. Чек: подпись проверяется офлайн, без обращения ко мне.
 *
 * Запуск:  npx tsx src/demoKeeperHub.ts
 * Требует: python tools/kh_mcp.py (OAuth-токен Claude Code) — см. его шапку.
 */
import { spawn } from 'node:child_process';
import { loadEnv } from './loadEnv.js';

loadEnv();

import { verifyIntent } from './verificationGate.js';
import { attestVerdict, verifyAttestation, attestorPublicKey } from './attestation.js';
import {
  setKeeperHubToolInvoker,
  executeOnChain,
  KEEPERHUB_AGENT_ADDRESS,
  SEPOLIA_CHAIN_ID,
} from './keeperhubAdapter.js';
import type { OnchainIntent, Verdict } from './types.js';

const KH_MCP = 'C:/Эксперимент/tools/kh_mcp.py';

/**
 * Настоящий исполнитель: зовёт инструмент KeeperHub через MCP.
 * Возвращает ИМЕННО `result` (адаптер сам разберёт {content:[{text}]}), а не весь конверт
 * JSON-RPC — иначе адаптер не найдёт полезную нагрузку и молча решит, что статус unknown.
 */
function realInvoker(tool: string, args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const p = spawn('python', [KH_MCP, tool, '--args', JSON.stringify(args)], { shell: false });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      try {
        const env = JSON.parse(out.trim());
        if (env.error) return reject(new Error('MCP error: ' + JSON.stringify(env.error)));
        resolve(env.result);
      } catch (e) {
        reject(new Error('не разобрала ответ MCP: ' + (out || err).slice(0, 300)));
      }
    });
    p.on('error', reject);
  });
}

setKeeperHubToolInvoker(realInvoker as any);

// ── Два намерения: одно должно быть ОТКЛОНЕНО, второе исполнено ───────────────
const DANGEROUS: OnchainIntent = {
  id: 'demo-danger-01',
  action: 'contractCall',
  chain: 'ethereum',
  to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  // approve(0xattacker, 2^256-1) — классический дрейнер: безлимитное разрешение тратить.
  // Calldata ДОЛЖНА лежать в params.calldata (или intent.calldata / params.data) — именно
  // там её ищет extractCalldata(). Прошлый черновик клал её в intent.data → декодер не видел
  // её и отказ шёл по структурной причине «нет params», а не «поймал дрейнера». Это была
  // дыра ДЕМО (продукт ловит верно — проверено пробой), но демо обязано показывать НАСТОЯЩУЮ
  // работу килл-фичи, а не случайный BLOCK.
  params: {
    calldata:
      '0x095ea7b3000000000000000000000000dead00000000000000000000000000000000beef' +
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  },
  rationale: 'approve a small USDC spend for a swap',
} as any;

// ⚠ ОТКРЫТЫЙ ВОПРОС (не решать подкруткой гейта!): PASS-ветка, которая РЕАЛЬНО исполняется,
// требует намерения, которое (а) гейт одобрит и (б) пройдёт on-chain. Нулевой перевод гейт
// СПРАВЕДЛИВО блокирует («amount must be positive») — и это правильное поведение фаервола,
// ослаблять его ради красивого демо = ровно тот подлог, от которого VEA защищает. Но именно
// нулевая сумма позволила сделать реальную tx на непополненном кошельке (0x2dc4…aabb).
// Развилка честная: либо кошелёк пополняется настоящей суммой (тогда SAFE = transfer amount>0),
// либо PASS-намерение — это БЕЗОПАСНЫЙ contractCall (не дрейнер), который гейт одобрит и который
// на Sepolia исполним. До пополнения демо показывает PASS в СУХОМ режиме (вердикт без броадкаста),
// а РЕАЛЬНОСТЬ исполнения доказана отдельно tx 0x2dc4…aabb (см. keeperhubAdapter.ts).
// ⚠️ id УНИКАЛЕН НА КАЖДЫЙ ПРОГОН — и это не косметика.
// Адаптер передаёт intent.id как idempotency_key: KeeperHub по нему защищает от двойной
// траты и на повторный ключ возвращает СТАРЫЙ результат, не выполняя ничего.
// С фиксированным 'demo-safe-01' демо показывало провал первого прогона (пустой кошелёк)
// даже после пополнения — тот же executionId, тот же текст ошибки. Выглядело как поломка
// исполнения, а на деле работала защита. Каждый прогон демо = новое намерение → новый id.
const SAFE: OnchainIntent = {
  id: `demo-safe-${Date.now().toString(36)}`,
  action: 'transfer',
  chain: 'sepolia',
  to: KEEPERHUB_AGENT_ADDRESS,
  amount: '0.0001',
  rationale: 'small self-transfer within limits — the kind of routine action the gate should PASS',
} as any;

function line(t = '') {
  console.log(t);
}

async function stage(title: string, intent: OnchainIntent, execute: boolean) {
  line('═'.repeat(72));
  line(title);
  line('═'.repeat(72));
  line(`intent  : ${intent.action} → ${intent.to}`);
  line(`agent   : "${(intent as any).rationale}"`);

  const verdict: Verdict = await verifyIntent(intent);
  line(`VERDICT : ${verdict.decision}   (confidence ${verdict.confidence})`);
  for (const r of verdict.reasons.slice(0, 4)) line(`          · ${r}`);

  const receipt = attestVerdict(intent, verdict);
  line(`receipt : signature valid offline = ${verifyAttestation(receipt)}`);

  if (verdict.decision === 'BLOCK') {
    line('EXECUTION: не выполняется — гейт отказал. Это и есть смысл фаервола.');
    return;
  }
  if (!execute) {
    line('EXECUTION: пропущена (сухой режим)');
    return;
  }

  line('EXECUTION: отправляю в KeeperHub (он подписывает и вещает; ключа у VEA нет)…');
  const res = await executeOnChain(intent, { chainId: SEPOLIA_CHAIN_ID });
  line(`  status  : ${(res as any).status ?? 'n/a'}`);
  const tx = (res as any).transactionHash ?? (res as any).txHash;
  if (tx) {
    line(`  tx      : ${tx}`);
    line(`  explorer: https://sepolia.etherscan.io/tx/${tx}`);
  } else {
    line(`  подробности: ${JSON.stringify(res).slice(0, 300)}`);
  }
}

async function main() {
  line();
  line('VEA — pre-flight firewall for agent transactions.');
  line(`attestor (Ed25519): ${attestorPublicKey()}`);
  line(`executor          : KeeperHub → ${KEEPERHUB_AGENT_ADDRESS} (Sepolia)`);
  line();

  await stage('1/2  ОПАСНОЕ НАМЕРЕНИЕ — должно быть отклонено', DANGEROUS, false);
  line();
  await stage('2/2  БЕЗОПАСНОЕ НАМЕРЕНИЕ — исполняется по-настоящему', SAFE, true);
  line();
  line('Обе ветки на одном движке: отказ и исполнение — не демо-режимы, а один и тот же гейт.');
}

main().catch((e) => {
  console.error('ОШИБКА:', e instanceof Error ? e.message : e);
  process.exit(1);
});
