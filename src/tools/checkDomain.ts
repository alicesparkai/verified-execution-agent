/**
 * checkDomain.ts — сверка пары EIP-712 (name/version) токена С ЦЕПОЧКОЙ, а не с документацией.
 *
 * ЗАЧЕМ: неверная пара name/version выглядит в JSON совершенно нормально, но делает КАЖДУЮ
 * подпись EIP-3009 невалидной — платёж не пройдёт, а причина будет невидима. Единственный
 * честный способ: взять DOMAIN_SEPARATOR, который контракт отдаёт НА ЦЕПОЧКЕ, и пересчитать
 * его самой из кандидатов. Совпало — пара верная. Не совпало — я бы подписывала мусор.
 *
 * Запуск: npx tsx src/tools/checkDomain.ts <chain: base|xlayer> <tokenAddress>
 */
import { createPublicClient, http, hashDomain, parseAbi } from 'viem';
import { base, xLayer } from 'viem/chains';

const CHAINS: Record<string, { chain: any; rpc: string }> = {
  base: { chain: base, rpc: 'https://mainnet.base.org' },
  xlayer: { chain: xLayer, rpc: 'https://rpc.xlayer.tech' },
};

const abi = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
]);

async function main() {
  const which = (process.argv[2] || 'base').toLowerCase();
  const token = (process.argv[3] || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') as `0x${string}`;
  const cfg = CHAINS[which];
  if (!cfg) throw new Error(`неизвестная сеть: ${which}`);

  const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
  const read = async (fn: string) => {
    try {
      return (await client.readContract({ address: token, abi, functionName: fn as any })) as any;
    } catch (e) {
      return `(нет: ${e instanceof Error ? e.message.slice(0, 60) : e})`;
    }
  };

  const [name, version, symbol, decimals, onchain] = await Promise.all([
    read('name'), read('version'), read('symbol'), read('decimals'), read('DOMAIN_SEPARATOR'),
  ]);

  console.log(`сеть      : ${which} (chainId ${cfg.chain.id})`);
  console.log(`токен     : ${token}`);
  console.log(`symbol    : ${symbol}   decimals: ${decimals}`);
  console.log(`name()    : ${JSON.stringify(name)}`);
  console.log(`version() : ${JSON.stringify(version)}`);
  console.log(`DOMAIN_SEPARATOR (с цепочки): ${onchain}`);

  if (typeof onchain !== 'string' || !onchain.startsWith('0x')) {
    console.log('\n⛔ контракт не отдал DOMAIN_SEPARATOR — сверить пару НЕЧЕМ, не угадывать.');
    return;
  }

  // Кандидаты: то, что вернул сам контракт, плюс частые варианты.
  const names = [name, symbol, 'USD Coin', 'USDC', 'USD₮0', 'Tether USD'].filter(
    (v, i, a) => typeof v === 'string' && !v.startsWith('(') && a.indexOf(v) === i,
  ) as string[];
  const versions = [version, '1', '2'].filter(
    (v, i, a) => typeof v === 'string' && !v.startsWith('(') && a.indexOf(v) === i,
  ) as string[];

  console.log('\nперебираю кандидатов (name × version), сравнивая пересчёт с цепочкой:');
  let hit: { name: string; version: string } | null = null;
  for (const n of names) {
    for (const v of versions) {
      const calc = hashDomain({
        domain: { name: n, version: v, chainId: cfg.chain.id, verifyingContract: token },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
        },
      } as any);
      const ok = calc.toLowerCase() === onchain.toLowerCase();
      console.log(`  ${ok ? '✅' : '  '} name=${JSON.stringify(n)} version=${JSON.stringify(v)} → ${calc.slice(0, 18)}…`);
      if (ok && !hit) hit = { name: n, version: v };
    }
  }

  console.log('');
  if (hit) {
    console.log(`✅ ПАРА ПОДТВЕРЖДЕНА ЦЕПОЧКОЙ: name=${JSON.stringify(hit.name)} version=${JSON.stringify(hit.version)}`);
    console.log(`   → extra: { name: ${JSON.stringify(hit.name)}, version: ${JSON.stringify(hit.version)}, decimals: ${decimals} }`);
  } else {
    console.log('⛔ НИ ОДИН кандидат не сошёлся. Не подставлять наугад — домен может включать salt');
    console.log('   или иной набор полей. Разбирать по исходнику контракта.');
  }
}

main().catch((e) => {
  console.error('ОШИБКА:', e instanceof Error ? e.message : e);
  process.exit(1);
});
