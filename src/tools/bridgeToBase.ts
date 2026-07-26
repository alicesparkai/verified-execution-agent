/**
 * bridgeToBase.ts — тонкая CLI-обёртка над bridgeBscToBase (логика живёт в src/x402/bridge.ts).
 *
 * Работает только там, где в окружении есть VEA_RELAYER_KEY. На моей машине его НЕТ (ключ
 * существует лишь как секрет Render, панель значения не отдаёт) — поэтому реальный завоз газа
 * делает сам сервис на старте по флагу VEA_BRIDGE_ONCE=1. Эта обёртка нужна для сухого прогона
 * и для случая, когда ключ окажется под рукой.
 *
 *   npx tsx src/tools/bridgeToBase.ts            # сухой прогон
 *   npx tsx src/tools/bridgeToBase.ts --execute  # реально мостить
 */
import { loadEnv } from '../loadEnv.js';

loadEnv();

const { bridgeBscToBase } = await import('../x402/bridge.js');

const r = await bridgeBscToBase(process.argv.includes('--execute'));
console.log('итог:', JSON.stringify(r, null, 2));
